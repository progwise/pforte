# Importing users from a CSV file

The back office usually exports its people as a spreadsheet. `pforte import` reads that file and
brings pforte in line with it, through the admin API. It is safe to run again: rows that change
nothing are reported as unchanged.

```sh
export PFORTE_URL=https://id.example.com
export PFORTE_CLIENT_ID=importer          # a machine client with the "directory" scope
export PFORTE_CLIENT_SECRET=…             # or PFORTE_CLIENT_SECRET_FILE=/path/to/file

pforte import users.csv --dry-run         # look first, writes nothing
pforte import users.csv                   # then do it
```

In this repository run it as `pnpm pforte import users.csv --dry-run`. The seed registers
`demo-import` (secret `dev-secret`) for that.

## The file

The first row names the columns, in any order. The delimiter (`,` or `;`) is detected, so a file
saved by a German Excel works. Save it as "CSV UTF-8"; for an older file use `--encoding windows-1252`.

| Column | Required | Notes |
| --- | --- | --- |
| `email` | yes | Identifies the user. Must be unique in the file. |
| `first_name`, `last_name` | yes | |
| `phone` | no | Spaces, dashes and brackets are removed; `0049…` becomes `+49…`. A blank cell clears the phone, a missing column leaves it alone. |
| `language` | no | Two or three letters, e.g. `de`. |
| any claim type | no | The key of a claim type, e.g. `partner_no`. Several values in one cell are separated by `;` (`--value-separator`). A blank cell removes that claim type from the user. |

A column that is neither of these stops the import and suggests the closest name ("did you mean
`partner_no`?"). `--ignore-unknown-columns` skips such columns with a warning instead.

## Rejected rows

A row with a problem (bad e-mail, a value that does not match the claim type's pattern, a second
value for a single-valued claim, a duplicate e-mail) is not imported; the others are. The summary
lists them with line number and reason, and `--rejected rejected.csv` writes them in the layout of
your file plus `line` and `reason` columns, so you can fix them and import that file again.
`--report report.json` writes everything, row by row.

## Users who are not in the file

By default they are left alone. `--missing=lock` locks them, `--missing=delete` deletes them (and
needs `--allow-delete`, since that cannot be undone). Administrators are never touched. Rows that
were rejected still count as present, so a typo does not lock the person. As protection against a
wrong or truncated file the import refuses to touch more than 20 % of the users
(`--max-missing-percent`, override with `--force`), and a file without a single valid row is refused.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Everything was imported. |
| 2 | The import ran, but some rows were rejected or failed. |
| 1 | The import could not run: no file, bad option, missing settings, unknown column, refused credentials, API unreachable. |

## Speed

Rows are sent in parallel (`--concurrency`, default 8). 3,000 rows took 2 s against a local server;
a repeat run with nothing to change took 1.5 s.
