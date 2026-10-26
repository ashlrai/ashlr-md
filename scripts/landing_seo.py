#!/usr/bin/env python3
"""Generate the checked-in sitemap for the existing zero-build static host."""
from datetime import datetime
from html.parser import HTMLParser
from pathlib import Path
import subprocess
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / 'landing'
ORIGIN = 'https://md.ashlr.ai'
REPO = 'https://github.com/ashlrai/ashlr-md/blob/main/'
NS = 'http://www.sitemaps.org/schemas/sitemap/0.9'
VOID = {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'}


class Element:
    def __init__(self, tag, attrs=(), parent=None):
        self.tag, self.attrs, self.parent = tag, dict(attrs), parent
        self.children = []

    def all(self, tag=None):
        for child in self.children:
            if tag is None or child.tag == tag:
                yield child
            yield from child.all(tag)


class Document(HTMLParser):
    def __init__(self, text):
        super().__init__(convert_charrefs=True)
        self.root = Element('document')
        self.current = self.root
        self.feed(text)
        self.close()

    def handle_starttag(self, tag, attrs):
        node = Element(tag, attrs, self.current)
        self.current.children.append(node)
        if tag not in VOID:
            self.current = node

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in VOID:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        node = self.current
        while node.parent:
            if node.tag == tag:
                self.current = node.parent
                return
            node = node.parent


def pages():
    return sorted(SITE.rglob('*.html'))


def canonical(page):
    relative = page.relative_to(SITE).as_posix()
    return ORIGIN + '/' + (relative[:-10] if relative.endswith('index.html') else relative)


def source_path(href):
    if not href.startswith(REPO):
        raise ValueError('Source must link to this repository: ' + href)
    relative = href[len(REPO):].split('#')[0]
    target = (ROOT / relative).resolve()
    if not target.is_relative_to(ROOT) or not target.is_file():
        raise ValueError('Missing repository source: ' + relative)
    return relative


def dependencies(page):
    doc = Document(page.read_text()).root
    paths = {page.relative_to(ROOT).as_posix()}
    for a in doc.all('a'):
        if 'data-source' in a.attrs:
            paths.add(source_path(a.attrs.get('href', '')))
    for link in doc.all('link'):
        if link.attrs.get('rel') == 'stylesheet':
            paths.add('landing/' + link.attrs['href'].lstrip('/'))
    return sorted(paths)


def lastmod(page):
    # Include cited docs and shared styles because they affect the published page.
    # Uncommitted files have no git timestamp. Their tracked dependencies supply
    # the provisional date; regenerate after the content commit before handoff.
    dates = subprocess.check_output(
        ['git', 'log', '-1', '--format=%cI', '--', *dependencies(page)],
        cwd=ROOT, text=True,
    ).strip()
    if not dates:
        raise ValueError('No git history for ' + str(page))
    datetime.fromisoformat(dates)
    return dates


def sitemap():
    ET.register_namespace('', NS)
    root = ET.Element(f'{{{NS}}}urlset')
    for page in pages():
        entry = ET.SubElement(root, f'{{{NS}}}url')
        ET.SubElement(entry, f'{{{NS}}}loc').text = canonical(page)
        ET.SubElement(entry, f'{{{NS}}}lastmod').text = lastmod(page)
    ET.indent(root, space='  ')
    return ET.tostring(root, encoding='utf-8', xml_declaration=True) + b'\n'


if __name__ == '__main__':
    (SITE / 'sitemap.xml').write_bytes(sitemap())
    print(f'Generated sitemap for {len(pages())} pages from git history.')
