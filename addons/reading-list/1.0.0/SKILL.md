# Reading list

Books, articles and papers the person wants to read, is reading, or has
finished. One collection, `items`. Each item has a `title` and a `status`
(`want`, `reading` or `done`), and may have `author`, `kind` (`book`,
`article`, `paper`, `other`), `url`, `rating` (1 to 5), `started_on` and
`finished_on` (YYYY-MM-DD), `notes` and `tags`.

## Capture

When the person mentions something they want to read, or says they started or
finished something, save it. Look first, so the same book is not added twice:

- `read_addon { addon: "reading-list", action: "list", args: { collection: "items", where: { title: "<title>" } } }`
- Not there: `use_addon { addon: "reading-list", action: "create", args: { collection: "items", data: { title, author?, kind?, url?, status: "want" } } }`

Only save a `url` the person gave you. Do not invent ratings or notes.

## Update

Change only what the person told you, with the record's id from a `list`:

- Started it: `use_addon { addon: "reading-list", action: "update", args: { collection: "items", id, patch: { status: "reading", started_on: "YYYY-MM-DD" } } }`
- Finished it: the same with `status: "done"`, `finished_on`, and a `rating` or `notes` if they gave one.
- A `null` value in `patch` removes that field.
- To delete an item, only when asked: `use_addon { addon: "reading-list", action: "remove", args: { collection: "items", id } }`

## List and answer

- What is on the list: `read_addon { addon: "reading-list", action: "list", args: { collection: "items", where: { status: "want" } } }`
- In progress: the same with `status: "reading"`. Finished: `status: "done"`.
- `where` matches top-level fields exactly; an array matches any of its values, for example `where: { status: ["want", "reading"] }`.
- Newest first by default; pass `order: "-updated_at"` for recently changed, and `cursor` from the reply for the next page.
- How many: `read_addon { addon: "reading-list", action: "count", args: { collection: "items", where: { status: "done" } } }`

When suggesting what to read next, choose from the person's own `want` items.

The list is personal: nobody else in the workspace can read it, owners
included.
