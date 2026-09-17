"""Builds tests/fixtures/eia_synthetic.xls, a small made up copy of EIA's workbook layout.

The committed .xls is what the tests read. You only need this script to
regenerate it, and it needs xlwt, which is not a project dependency:

    python -m venv /tmp/xlwt && /tmp/xlwt/bin/pip install xlwt==1.3.0
    /tmp/xlwt/bin/python tests/fixtures/build_eia_xls.py

Layout matches psw18vwall.xls: a Contents sheet with release dates and a
Data 1 sheet with a title row, Sourcekey row, long names row, then one row per
Monday. All prices are invented by a formula.
"""

import math
from datetime import date, timedelta
from pathlib import Path

import xlwt

KEYS = ["NUS", "R10", "R1X", "R1Y", "R1Z", "R20", "R30", "R40", "R50", "SCA", "R5XCA"]
OFFSETS = [0.0, -0.05, 0.10, 0.12, -0.10, -0.02, -0.25, -0.15, 0.95, 1.60, 0.30]
FIRST = date(2022, 5, 23)  # 3 weeks before the 2022-06-13 cutoff
LAST = date(2026, 9, 14)
BLANK = {(date(2023, 1, 2), "R40")}  # one blank cell in a kept row


def excel_serial(d: date) -> float:
    return float((d - date(1899, 12, 30)).days)


def price(i: int, k: int) -> float:
    base = 4.60 + 0.9 * math.sin(i / 11.0) + 0.004 * i
    return round(base + OFFSETS[k], 3)


def main() -> None:
    wb = xlwt.Workbook()
    date_style = xlwt.easyxf(num_format_str="mmm dd, yyyy")

    c = wb.add_sheet("Contents")
    c.write(1, 1, "Workbook Contents")
    c.write(2, 1, "U.S. On-Highway Diesel Fuel Prices (synthetic test copy)")
    c.write(13, 1, "Release Date:")
    c.write(13, 2, "9/15/2026")
    c.write(14, 1, "Next Release Date:")
    c.write(14, 2, "9/22/2026")

    d = wb.add_sheet("Data 1")
    d.write(0, 0, "Back to Contents")
    d.write(0, 1, "Data 1: W Diesel Prices, All Types (synthetic)")
    d.write(1, 0, "Sourcekey")
    d.write(2, 0, "Date")
    for k, key in enumerate(KEYS):
        d.write(1, k + 1, f"EMD_EPD2D_PTE_{key}_DPG")
        d.write(2, k + 1, f"Weekly {key} No 2 Diesel Retail Prices  (Dollars per Gallon)")

    row = 3
    period = FIRST
    i = 0
    while period <= LAST:
        d.write(row, 0, excel_serial(period), date_style)
        for k, key in enumerate(KEYS):
            if (period, key) in BLANK:
                continue
            if period < date(2022, 6, 13) and key in ("R1X", "R1Y", "R1Z", "SCA", "R5XCA"):
                continue  # old rows have gaps, like the real file
            value = price(i, k)
            if period < date(2022, 6, 13) and key == "NUS":
                value = 1.106  # below the 1.5 floor, fine because the row is dropped
            d.write(row, k + 1, value)
        row += 1
        i += 1
        period += timedelta(days=7)

    out = Path(__file__).with_name("eia_synthetic.xls")
    wb.save(str(out))
    print(f"wrote {out} with {row - 3} weeks")


if __name__ == "__main__":
    main()
