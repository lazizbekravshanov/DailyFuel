# AAA data

This folder is for daily state diesel averages from AAA (gasprices.aaa.com), data by OPIS.

AAA and OPIS data is not covered by this repo's MIT license. The MIT license covers the code only. AAA and OPIS keep their rights to their numbers, and you can't reuse anything in this folder under the MIT license.

Right now AAA is switched off. DailyFuel is asking AAA for permission first, so nothing contacts AAA and there is no AAA data here yet. The `daily/` folder only shows up after the owner gets written permission and sets the `AAA_ENABLED` repo variable to `true`.

When it's on, each file in `daily/` holds one day: the 51 state diesel averages and the national diesel average for today and yesterday. Nothing else is stored. No other grades, no metro prices, no copies of AAA's pages.

If AAA or OPIS ever objects, set `AAA_ENABLED` to `false`, run the update job once, and delete `daily/`.

DailyFuel is not affiliated with AAA or OPIS.
