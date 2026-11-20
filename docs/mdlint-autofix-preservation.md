# What Markdown autofix preserves

The linter's link and image fixes change only the Markdown being fixed: labels,
image sources, the prose around them, punctuation, and the final newline stay
as they were. These examples reproduce cases in
[the autofix tests](../src/lib/mdlint-autofix.test.ts), and
`src/lib/mdlint-autofix-preservation.test.ts` checks each one against this
page. Linting reports a suggestion; **Fix** applies one available fix and
**Fix all** applies the available fixes together.

## Prose around a link

The `rule:invalid-link-target` test named “autofix preserves surrounding text”
checks this single fix. An invalid `#` destination becomes `TODO`; the label,
surrounding words, punctuation, and final newline remain unchanged.

Before:

<!-- example: link before -->
```md
Before [link](#) after.
```

After:

<!-- example: link after -->
```md
Before [link](TODO) after.
```

Replace `TODO` with the intended URL or path.

## Prose around an image

`missing-alt-text` replaces empty alternative text with a placeholder, keeping
the image source and the text before and after it.

Before:

<!-- example: image before -->
```md
Before ![](img.png) after.
```

After:

<!-- example: image after -->
```md
Before ![TODO: describe image](img.png) after.
```

Replace the placeholder with suitable alternative text.

## A bracketed word after both fixes

The LF case of “preserves a bracketed word at the end of a paragraph and its
final newline” applies the link and image fixes to one line. The empty link
destination becomes `TODO` and the empty alt text becomes
`TODO: describe image`; the image source, the trailing `[note]`, the prose and
the final newline stay as they were. A second lint and fix pass leaves the
result unchanged.

Before:

<!-- example: bracket before -->
```md
Read [draft]() and see ![](chart.png) for details [note]
```

After:

<!-- example: bracket after -->
```md
Read [draft](TODO) and see ![TODO: describe image](chart.png) for details [note]
```

`[note]` has no destination, so it is plain text to the linter and is not
reported as a link.

## Image sources in Fix all

The test “Fix all preserves both image sources while fixing an empty alt and a
later link” checks the combined result below. The existing image description
and both sources, including their queries and fragments, stay intact. The
empty alt text and invalid link destination receive placeholders; the prose
and final newline are preserved too. The test also checks that a second Fix
all pass leaves the result and fix history unchanged.

Before:

<!-- example: combined before -->
```md
See ![A café map](images/map.svg?view=full#north) beside ![](images/chart.png?size=2#data), then [details]().
```

After:

<!-- example: combined after -->
```md
See ![A café map](images/map.svg?view=full#north) beside ![TODO: describe image](images/chart.png?size=2#data), then [details](TODO).
```

Replace `TODO` with the intended destination and `TODO: describe image` with
appropriate alternative text. These placeholders clear the corresponding
warnings but do not supply a finished link or description. See the
[autofix guide](mdlint-autofix-guide.md) for rule scope and overlapping fixes.
