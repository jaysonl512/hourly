# Hourly

A simple time tracker for hourly work that shows how close you are to covering your monthly bills.

## Features

- **Timer with pause and resume.** One entry can hold several time blocks.
- **Accurate time.** The app saves the actual timestamp each time you press start, pause or resume, and works out elapsed time from those timestamps. Refreshing, closing the tab or putting the laptop to sleep doesn't lose or add time.
- **Rate per session.** Each project remembers its last rate, and you can change it before (or during) any session.
- **Monthly bills in CAD or USD.** CAD amounts are converted at the daily European Central Bank rate from [Frankfurter](https://frankfurter.dev).
- **Progress bars.** A total bar plus one bar per bill, filled smallest-first (or proportionally). Once your bills are covered, the app shows your extra earnings.
- **History.** Grouped by day. You can edit, delete (with undo) or add time manually.
- **Outside earnings.** Add money earned during a month that isn't logged in the app.
- **Optional tax set-aside** (in Settings, off by default).
- **Backup.** Export or import JSON, and export time to CSV.

## Data

Everything is stored in your browser's `localStorage`. Nothing is sent anywhere except the exchange-rate lookup. Data doesn't sync between browsers or devices, so export a backup now and then.

## Running locally

It's a static site with no build step:

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000.
