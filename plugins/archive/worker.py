#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""压缩包读取 worker（zip / rar / 7z / tar 系列）——无需完整解压即可 list / read / grep。

协议：stdin 收一行 JSON 请求，stdout 吐一行 JSON 结果。
  {"cmd":"list|read|grep|extract|info", "archive":"C:/a.zip", ...}
"""
import sys, os, io, json, re, zipfile, tarfile, tempfile, shutil, fnmatch

sys.stdout.reconfigure(encoding='utf-8', errors='replace')
sys.stdin.reconfigure(encoding='utf-8', errors='replace')

UNRAR = r'C:\Program Files\WinRAR\UnRAR.exe'


class Entry:
    __slots__ = ('name', 'size', 'compressed', 'mtime', 'is_dir')

    def __init__(self, name, size=0, compressed=0, mtime='', is_dir=False):
        self.name = name
        self.size = size
        self.compressed = compressed
        self.mtime = mtime
        self.is_dir = is_dir

    def as_dict(self):
        return {'name': self.name, 'size': self.size, 'compressed': self.compressed,
                'mtime': self.mtime, 'is_dir': self.is_dir}


def _fix_zip_name(name, flag_bits):
    """zip 里不带 UTF-8 标志的名字被 zipfile 按 cp437 解码 → 还原字节再试 utf-8 / gbk。"""
    if flag_bits & 0x800:
        return name
    try:
        raw = name.encode('cp437')
    except Exception:
        return name
    if all(b < 0x80 for b in raw):
        return name
    for enc in ('utf-8', 'gbk', 'big5'):
        try:
            return raw.decode(enc)
        except Exception:
            continue
    return name


def _fmt_time(t):
    try:
        return '%04d-%02d-%02d %02d:%02d:%02d' % tuple(t[:6])
    except Exception:
        return ''


# ---------------------------------------------------------------- adapters

class ZipAdapter:
    kind = 'zip'

    def __init__(self, path, password=None):
        self.path = path
        self.zf = zipfile.ZipFile(path)
        self.pwd = password.encode() if password else None
        self.entries = []
        self._by_name = {}
        for i in self.zf.infolist():
            real = _fix_zip_name(i.filename, i.flag_bits)
            e = Entry(real, i.file_size, i.compress_size, _fmt_time(i.date_time),
                      real.endswith('/') or i.is_dir())
            self.entries.append(e)
            self._by_name[real] = i

    def read(self, name):
        info = self._by_name.get(name)
        if info is None:
            raise KeyError('条目不存在: %s' % name)
        return self.zf.read(info, pwd=self.pwd)

    def read_range(self, name, offset, size):
        """只取一段字节，避免把几百 MB 的条目整个读进内存。"""
        info = self._by_name.get(name)
        if info is None:
            raise KeyError('条目不存在: %s' % name)
        with self.zf.open(info, pwd=self.pwd) as f:
            if offset:
                f.seek(offset)
            return f.read(size)

    def close(self):
        try:
            self.zf.close()
        except Exception:
            pass


class RarAdapter:
    kind = 'rar'

    def __init__(self, path, password=None):
        import rarfile
        if os.path.exists(UNRAR):
            rarfile.UNRAR_TOOL = UNRAR
        rarfile.DEFAULT_CHARSET = 'gbk'
        self.path = path
        self.rf = rarfile.RarFile(path)
        self.entries = []
        self.pwd = password
        for i in self.rf.infolist():
            self.entries.append(Entry(i.filename, i.file_size, i.compress_size,
                                      _fmt_time(getattr(i, 'date_time', ()) or ()),
                                      i.is_dir()))

    def read(self, name):
        return self.rf.read(name, pwd=self.pwd)

    def read_range(self, name, offset, size):
        with self.rf.open(name, pwd=self.pwd) as f:
            if offset:
                f.seek(offset)
            return f.read(size)

    def close(self):
        try:
            self.rf.close()
        except Exception:
            pass


class SevenZipAdapter:
    """py7zr 没有流式 read()：7z 是 solid 压缩，读一条也要解整块。
    单条读取用 extract(targets=[name])；批量（grep）时 prepare_bulk() 一次解压到临时目录再逐条读。"""
    kind = '7z'
    BULK_LIMIT = 1024 ** 3  # 1GB 以上不整包解压

    def __init__(self, path, password=None):
        import py7zr
        self.path = path
        self.password = password
        self._tmp = None
        self._bulk = None
        with py7zr.SevenZipFile(path, password=password) as z:
            self.entries = []
            for f in z.list():
                self.entries.append(Entry(f.filename, f.uncompressed or 0, f.compressed or 0,
                                          str(f.creationtime or ''), bool(f.is_directory)))

    @property
    def total_size(self):
        return sum(e.size for e in self.entries if not e.is_dir)

    def _extract(self, targets=None):
        import py7zr
        if self._tmp is None:
            self._tmp = tempfile.mkdtemp(prefix='arc7z-')
        with py7zr.SevenZipFile(self.path, password=self.password) as z:
            z.extract(path=self._tmp, targets=targets)
        return self._tmp

    def prepare_bulk(self):
        """grep 前调用：一次解压整包，省掉逐条重开压缩流（solid 压缩尤其慢）。"""
        if self._bulk is None and self.total_size <= self.BULK_LIMIT:
            self._bulk = self._extract(None)
        return self._bulk

    def _local(self, root, name):
        return os.path.join(root, *name.replace('\\', '/').split('/'))

    def read(self, name):
        if self._bulk:
            p = self._local(self._bulk, name)
            if os.path.isfile(p):
                with open(p, 'rb') as f:
                    return f.read()
        root = self._extract([name])
        with open(self._local(root, name), 'rb') as f:
            return f.read()

    def read_range(self, name, offset, size):
        if self._bulk:
            p = self._local(self._bulk, name)
            if os.path.isfile(p):
                with open(p, 'rb') as f:
                    f.seek(offset)
                    return f.read(size)
        root = self._extract([name])
        with open(self._local(root, name), 'rb') as f:
            f.seek(offset)
            return f.read(size)

    def extract_all(self, dest):
        import py7zr
        with py7zr.SevenZipFile(self.path, password=self.password) as z:
            z.extractall(path=dest)

    def close(self):
        if self._tmp and os.path.isdir(self._tmp):
            shutil.rmtree(self._tmp, ignore_errors=True)


class TarAdapter:
    kind = 'tar'

    def __init__(self, path, password=None):
        self.tf = tarfile.open(path, 'r:*')
        self.entries = []
        for m in self.tf.getmembers():
            self.entries.append(Entry(m.name, m.size, 0,
                                      _fmt_time(__import__('time').localtime(m.mtime)),
                                      m.isdir()))

    def read(self, name):
        f = self.tf.extractfile(name)
        if f is None:
            raise KeyError('条目不存在或不是文件: %s' % name)
        return f.read()

    def read_range(self, name, offset, size):
        f = self.tf.extractfile(name)
        if f is None:
            raise KeyError('条目不存在或不是文件: %s' % name)
        if offset:
            f.seek(offset)
        return f.read(size)

    def close(self):
        try:
            self.tf.close()
        except Exception:
            pass


def open_archive(path, password=None):
    if not os.path.exists(path):
        raise FileNotFoundError('文件不存在: %s' % path)
    # 先看魔数再看扩展名：WinRAR 会生成「名叫 .zip 其实是 RAR」的文件，
    # 各种工具也常把 tar.gz 改名 .tgz / .bin，扩展名并不可靠。
    with open(path, 'rb') as f:
        head = f.read(512)
    low = path.lower()
    if head[:2] == b'PK':
        return ZipAdapter(path, password)
    if head[:4] == b'Rar!':
        return RarAdapter(path, password)
    if head[:6] == b'7z\xbc\xaf\x27\x1c':
        return SevenZipAdapter(path, password)
    if len(head) >= 262 and head[257:262] == b'ustar':
        return TarAdapter(path, password)          # 未压缩 tar
    if head[:2] == b'\x1f\x8b' or head[:3] == b'BZh' or head[:6] == b'\xfd7zXZ\x00' \
            or head[:4] == b'\x28\xb5\x2f\xfd':
        # gzip/bzip2/xz/zstd：可能是 tar 包也可能不是，交给 tarfile 自己判断
        if tarfile.is_tarfile(path):
            return TarAdapter(path, password)
        raise ValueError('这是单文件压缩流（gz/bz2/xz），不是 tar 包，无法列目录: %s'
                         % os.path.basename(path))
    # 魔数不认识：退回扩展名
    if low.endswith(('.zip', '.zipx', '.jar', '.whl', '.apk', '.docx', '.xlsx', '.pptx', '.nupkg', '.epub')):
        return ZipAdapter(path, password)
    if low.endswith(('.rar', '.rev')) or re.search(r'\.part\d+\.rar$', low):
        return RarAdapter(path, password)
    if low.endswith('.7z'):
        return SevenZipAdapter(path, password)
    if low.endswith(('.tar', '.tar.gz', '.tgz', '.tar.bz2', '.tbz2', '.tbz', '.tar.xz', '.txz', '.tar.zst')):
        return TarAdapter(path, password)
    raise ValueError('不认识的压缩格式（暂支持 zip / rar / 7z / tar.gz|bz2|xz）: %s' % os.path.basename(path))


# ---------------------------------------------------------------- helpers

def sniff(data, encoding='auto'):
    """返回 (is_text, encoding)。先判断文本/二进制，再定编码，避免把 UTF-16 文本误判成二进制。
    注意：必须用「完整数据」判断，截断到多字节字符中间会导致 utf-8 解码失败。"""
    if encoding and encoding != 'auto':
        return True, encoding
    if not data:
        return True, 'utf-8'
    if data[:3] == b'\xef\xbb\xbf':
        return True, 'utf-8-bom'
    if data[:2] in (b'\xff\xfe', b'\xfe\xff'):
        return True, 'utf-16'
    try:
        data.decode('utf-8')
        return True, 'utf-8'
    except UnicodeDecodeError as e:
        # 只读了一部分时可能是尾部截断，宽松匹配
        try:
            data[:e.start].decode('utf-8')
            if e.start > len(data) - 8:
                return True, 'utf-8'
        except Exception:
            pass
    try:
        data.decode('gbk')
        return True, 'gbk'
    except Exception:
        pass
    sample = data[:8192]
    if b'\x00' in sample:
        # UTF-16LE 英文/中文文本：大量交替的 0 字节
        if len(sample) >= 4:
            odd0 = sum(1 for i in range(1, len(sample), 2) if sample[i] == 0)
            even0 = sum(1 for i in range(0, len(sample), 2) if sample[i] == 0)
            half = len(sample) // 2 or 1
            if odd0 / half > 0.6:
                return True, 'utf-16-le'
            if even0 / half > 0.6:
                return True, 'utf-16-be'
        return False, None
    bad = sum(1 for b in sample if b < 9 or (13 < b < 32))
    if bad / len(sample) > 0.15:
        return False, None
    return True, 'latin-1'


def decode_text(data, encoding):
    try:
        return data.decode(encoding, 'replace')
    except LookupError:
        return data.decode('utf-8', 'replace')


def match_filter(name, pattern):
    if not pattern:
        return True
    name = name.replace('\\', '/')
    base = name.rsplit('/', 1)[-1]
    pats = [p.strip() for p in pattern.split(',') if p.strip()]
    for p in pats:
        if fnmatch.fnmatch(name.lower(), p.lower()) or fnmatch.fnmatch(base.lower(), p.lower()):
            return True
        if p.lower() in name.lower():          # 退化为子串匹配
            return True
    return False


def pick(entries, name):
    """按完整名 / 忽略大小写 / 后缀 唯一匹配条目。"""
    names = {e.name: e for e in entries if not e.is_dir}
    if name in names:
        return names[name]
    low = name.replace('\\', '/').lower()
    for e in entries:
        if e.is_dir:
            continue
        if e.name.replace('\\', '/').lower() == low:
            return e
    cands = [e for e in entries if not e.is_dir and e.name.replace('\\', '/').lower().endswith(low)]
    if len(cands) == 1:
        return cands[0]
    if len(cands) > 1:
        raise ValueError('条目名不唯一，请写全路径，候选: %s' % ', '.join(c.name for c in cands[:10]))
    raise KeyError('找不到条目: %s' % name)


# ---------------------------------------------------------------- commands

def cmd_info(req):
    a = open_archive(req['archive'], req.get('password'))
    try:
        files = [e for e in a.entries if not e.is_dir]
        size = os.path.getsize(req['archive'])
        tot = sum(e.size for e in files)
        comp = sum(e.compressed for e in files) or size
        return {'ok': True, 'kind': a.kind, 'archive': os.path.abspath(req['archive']),
                'archiveSize': size, 'entries': len(a.entries), 'files': len(files),
                'dirs': len(a.entries) - len(files), 'totalSize': tot,
                'ratio': (round(tot / comp, 2) if comp else None),
                'topLevel': sorted({e.name.split('/')[0] for e in a.entries})[:20],
                'hasPassword': bool(req.get('password'))}
    finally:
        a.close()


def cmd_list(req):
    a = open_archive(req['archive'], req.get('password'))
    try:
        show_dirs = req.get('showDirs', False)
        rows = [e for e in a.entries if show_dirs or not e.is_dir]
        rows = [e for e in rows if match_filter(e.name, req.get('filter'))]
        total = len(rows)
        limit = int(req.get('limit') or 2000)
        rows = rows[:limit]
        return {'ok': True, 'kind': a.kind, 'total': total, 'shown': len(rows),
                'truncated': total > len(rows),
                'entries': [e.as_dict() for e in rows]}
    finally:
        a.close()


def cmd_read(req):
    a = open_archive(req['archive'], req.get('password'))
    try:
        e = pick(a.entries, req['entry'])
        max_bytes = int(req.get('maxBytes') or 2 * 1024 * 1024)
        offset = int(req.get('offset') or 0)
        # 先拿头部判编码（最多 64KB），再按需读指定区间：几百 MB 的条目也不会撑爆内存
        head = a.read_range(e.name, 0, min(e.size or 0, 65536)) if e.size else b''
        is_text, enc = sniff(head, req.get('encoding'))
        chunk = a.read_range(e.name, offset, max_bytes)
        truncated = offset + len(chunk) < e.size
        if truncated and enc in ('utf-8', 'utf-8-bom', 'gbk'):
            # 别在多字节字符中间断开，否则末尾出现半截乱码
            while chunk and (chunk[-1] & 0xC0) == 0x80:
                chunk = chunk[:-1]
            if chunk and chunk[-1] >= 0xC0:
                chunk = chunk[:-1]
        out = {'ok': True, 'entry': e.name, 'size': e.size, 'bytesRead': len(chunk),
               'truncated': truncated, 'offset': offset}
        if not is_text:
            import binascii
            out['binary'] = True
            out['preview'] = binascii.hexlify(chunk[:256]).decode()
            out['note'] = '二进制文件，仅给 hex 预览前 256 字节'
            return out
        out['encoding'] = enc
        out['content'] = decode_text(chunk, enc)
        return out
    finally:
        a.close()


def cmd_grep(req):
    a = open_archive(req['archive'], req.get('password'))
    try:
        pat = req['pattern']
        flags = re.MULTILINE | (re.IGNORECASE if req.get('ignoreCase') else 0)
        rx = re.compile(pat, flags)
        ctx = int(req.get('context') or 0)
        max_hits = int(req.get('maxHits') or 100)
        max_file = int(req.get('maxFileSize') or 5 * 1024 * 1024)
        hits, scanned, skipped = [], 0, []
        if hasattr(a, 'prepare_bulk'):
            try:
                a.prepare_bulk()   # 7z solid：一次解压，别逐条重开压缩流
            except Exception:
                pass
        for e in a.entries:
            if e.is_dir or not match_filter(e.name, req.get('filter')):
                continue
            if e.size > max_file:
                skipped.append({'name': e.name, 'size': e.size, 'reason': 'too-large'})
                continue
            try:
                data = a.read(e.name)
            except Exception as ex:
                skipped.append({'name': e.name, 'reason': str(ex)[:80]})
                continue
            scanned += 1
            is_text, enc = sniff(data)
            if not is_text:
                continue
            text = decode_text(data, enc)
            lines = text.splitlines()
            for i, line in enumerate(lines):
                if rx.search(line):
                    block = []
                    if ctx:
                        lo, hi = max(0, i - ctx), min(len(lines), i + ctx + 1)
                        block = [{'n': j + 1, 'text': lines[j][:400]} for j in range(lo, hi)]
                    hits.append({'file': e.name, 'line': i + 1, 'text': line[:400], 'context': block})
                    if len(hits) >= max_hits:
                        return {'ok': True, 'hits': hits, 'scanned': scanned, 'skipped': skipped,
                                'truncated': True}
        return {'ok': True, 'hits': hits, 'scanned': scanned, 'skipped': skipped, 'truncated': False}
    finally:
        a.close()


def _safe_join(dest, name):
    parts = [p for p in name.replace('\\', '/').split('/') if p not in ('', '.', '..')]
    out = os.path.join(dest, *parts)
    root = os.path.abspath(dest)
    if not os.path.abspath(out).startswith(root + os.sep) and os.path.abspath(out) != root:
        raise ValueError('非法路径（疑似穿越）: %s' % name)
    return out


def cmd_extract(req):
    path = req['archive']
    dest = os.path.abspath(req['dest'])
    os.makedirs(dest, exist_ok=True)
    a = open_archive(path, req.get('password'))
    written = []
    try:
        want = req.get('entries')
        targets = [pick(a.entries, n) for n in want] if want else [e for e in a.entries if not e.is_dir]
        if isinstance(a, SevenZipAdapter) and not want:
            a.extract_all(dest)
            for e in a.entries:
                if not e.is_dir:
                    written.append(_safe_join(dest, e.name))
        else:
            for e in targets:
                if e.is_dir:
                    continue
                out = _safe_join(dest, e.name)
                os.makedirs(os.path.dirname(out), exist_ok=True)
                with open(out, 'wb') as f:
                    f.write(a.read(e.name))
                written.append(out)
        return {'ok': True, 'dest': dest, 'count': len(written),
                'files': [os.path.relpath(p, dest).replace('\\', '/') for p in written[:200]]}
    finally:
        a.close()


CMDS = {'info': cmd_info, 'list': cmd_list, 'read': cmd_read, 'grep': cmd_grep, 'extract': cmd_extract}


def main():
    try:
        raw = sys.stdin.read()
        req = json.loads(raw)
        fn = CMDS.get(req.get('cmd'))
        if not fn:
            raise ValueError('未知命令: %s' % req.get('cmd'))
        res = fn(req)
    except Exception as e:
        res = {'ok': False, 'error': '%s: %s' % (type(e).__name__, e)}
    sys.stdout.write(json.dumps(res, ensure_ascii=False))
    sys.stdout.flush()


if __name__ == '__main__':
    main()
