"""把 unittest 的失敗區塊轉成 GitHub Actions annotation（::error::），在執行頁面直接看得到。"""
import re
import sys

log = open(sys.argv[1], encoding="utf-8", errors="replace").read()
for block in re.split(r"\n={50,}\n", log)[1:]:
    head, _, rest = block.partition("\n")
    detail = rest.split("\n" + "-" * 50)[0] if "\n" + "-" * 50 in rest else rest
    detail = detail.strip()[-1500:]
    esc = lambda t: t.replace("%", "%25").replace("\r", "").replace("\n", "%0A")
    print("::error title=" + esc(head.strip()[:150]).replace(",", "%2C").replace(":", "%3A") + "::" + esc(detail))
