#!/usr/bin/env python
"""
把 dist/ 打成造化能接受的 ZIP。

为什么需要这个脚本（血泪结论，别再试错）：
1. **造化拒收根目录条目**。ZIP 里出现 `index.html` 这种顶层文件，远端直接返回
   `zip_unsafe_path`。必须是 `dist/index.html` 这种带目录前缀的路径。
2. **不要用 PowerShell 的 Compress-Archive**：PS 5.1 写出的条目路径用反斜杠
   （`dist\\index.html`），Linux 侧解压器视为非法路径。
   Python 的 zipfile 固定写正斜杠，稳定。

用法：
    python pack.py            # 产出 csp-probe-upload.zip
然后：
    game_builder_build_and_upload_current_directory(
        archive_path="...\\csp-probe-upload.zip",
        fast_upload=True, confirm_skip_validation_risk=True, confirm_publish=True)
"""
import os
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.join(HERE, "dist")
OUT = os.path.join(HERE, "csp-probe-upload.zip")


def main() -> int:
    if not os.path.isfile(os.path.join(DIST, "index.html")):
        print("[pack] dist/index.html 不存在，先跑 node build.mjs", file=sys.stderr)
        return 1

    if os.path.exists(OUT):
        os.remove(OUT)

    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as z:
        for root, _dirs, files in os.walk(DIST):
            for name in files:
                full = os.path.join(root, name)
                # 关键：rel 必须以 dist/ 开头，用正斜杠
                rel = os.path.relpath(full, HERE).replace(os.sep, "/")
                if not rel.startswith("dist/"):
                    raise SystemExit(f"[pack] 拒绝写入 dist/ 之外的条目: {rel}")
                z.write(full, rel)

    with zipfile.ZipFile(OUT) as z:
        entries = [(i.filename, i.file_size) for i in z.infolist()]
    print(f"[pack] {OUT}  ({os.path.getsize(OUT)} bytes)")
    for name, size in entries:
        print(f"       {name}  {size} bytes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
