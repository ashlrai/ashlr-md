import hashlib
import importlib.util
from pathlib import Path
import stat
import tempfile
import unittest
from unittest import mock
import zipfile

s = importlib.util.spec_from_file_location('release_archive', Path(__file__).with_name('release-archive.py'))
a = importlib.util.module_from_spec(s); s.loader.exec_module(a)

class Tests(unittest.TestCase):
    def setUp(self): self.tmp = tempfile.TemporaryDirectory(); self.root = Path(self.tmp.name); self.z = self.root / 'x.zip'
    def tearDown(self): self.tmp.cleanup()
    def digest(self): return 'sha256:' + hashlib.sha256(self.z.read_bytes()).hexdigest()
    def write(self, entries):
        with zipfile.ZipFile(self.z, 'w') as f:
            for name, data in entries: f.writestr(name, data)
    def test_verified(self):
        self.write([('a/b', b'hello'), ('c', b'x')]); out = self.root / 'out'
        hashes = a.unpack_verified(self.z, self.digest(), out)
        self.assertEqual((out/'a/b').read_bytes(), b'hello')
        self.assertEqual(hashes['a/b'], hashlib.sha256(b'hello').hexdigest())
        self.assertEqual((out.stat().st_mode & 0o777), 0o700)
    def test_digest_before_extraction(self):
        self.write([('a',b'x')])
        with self.assertRaisesRegex(ValueError,'digest mismatch'): a.unpack_verified(self.z, 'sha256:'+'0'*64, self.root/'out')
        self.assertFalse((self.root/'out').exists())
    def test_traversal_duplicate_and_collision(self):
        for entries in [[('../outside',b'x')], [('A',b'x'),('a',b'y')], [('A/x',b'x'),('a/y',b'y')], [('a',b'x'),('a/b',b'y')], [('C:/evil',b'x')], [('a\\b',b'x')]]:
            self.write(entries)
            with self.assertRaises(ValueError): a.unpack_verified(self.z,self.digest(),self.root/'out')
            self.assertFalse((self.root/'out').exists())
    def test_symlink(self):
        info = zipfile.ZipInfo('link'); info.create_system = 3; info.external_attr = (stat.S_IFLNK|0o777)<<16
        self.write([(info,b'../elsewhere')])
        with self.assertRaisesRegex(ValueError,'non-regular'): a.unpack_verified(self.z,self.digest(),self.root/'out')
    def test_size_ratio_and_entry_limits(self):
        self.write([('a',b'x' * 64), ('b', b'y')])
        with mock.patch.object(a, 'MAX_FILE', 63):
            with self.assertRaisesRegex(ValueError, 'size exceeds'): a.unpack_verified(self.z,self.digest(),self.root/'out')
        with mock.patch.object(a, 'MAX_TOTAL', 64):
            with self.assertRaisesRegex(ValueError, 'total size'): a.unpack_verified(self.z,self.digest(),self.root/'out')
        with mock.patch.object(a, 'MAX_ENTRIES', 1):
            with self.assertRaisesRegex(ValueError, 'too many'): a.unpack_verified(self.z,self.digest(),self.root/'out')
        with zipfile.ZipFile(self.z,'w',compression=zipfile.ZIP_DEFLATED) as f: f.writestr('compressed',b'0'*4096)
        with mock.patch.object(a, 'MAX_RATIO', 2):
            with self.assertRaisesRegex(ValueError, 'compression ratio'): a.unpack_verified(self.z,self.digest(),self.root/'out')
    def test_unicode_collision_and_bad_digest_format(self):
        self.write([('é/a', b'x'), ('e\u0301/b', b'y')])
        with self.assertRaisesRegex(ValueError, 'ambiguous'): a.unpack_verified(self.z,self.digest(),self.root/'out')
        with self.assertRaisesRegex(ValueError, 'malformed'): a.unpack_verified(self.z,'sha256:bad',self.root/'out')
    def test_existing_destination(self):
        self.write([('a',b'x')]); (self.root/'out').mkdir()
        with self.assertRaisesRegex(ValueError,'already exists'): a.unpack_verified(self.z,self.digest(),self.root/'out')

if __name__ == '__main__': unittest.main()
