# Reviewing Markdown lint placeholders

The linter's **Fix** and **Fix all** actions can insert placeholders where only
an author can supply the intended content. **Every placeholder requires review**
before the document is ready to share. A warning disappearing does not mean the
link works or the image has useful alternative text: the linter accepts these
nonempty placeholders and does not check destinations or judge descriptions.

Search the document for `TODO` after applying fixes. Review each match in context;
some may be unrelated author notes. The two generated forms are a `TODO` link or
image destination and `TODO: describe image` as image alt text. If you cannot
determine the intended content, leave the placeholder visible for a knowledgeable
author to resolve rather than guessing.

## Replace a link destination

`invalid-link-target` replaces an empty or whitespace-only destination, `#`, or
`?` with `TODO`. Find the intended page, file, or section from the surrounding
text, then replace only the destination. For example:

<!-- example: link before -->
```md
Read the [installation guide]().
```

After autofix:

<!-- example: link placeholder -->
```md
Read the [installation guide](TODO).
```

After review, if the guide is the local `installation.md` file:

<!-- example: link reviewed -->
```md
Read the [installation guide](./installation.md).
```

Open the link in the intended publishing context and check that it reaches the
right page or section; check relative paths and anchors as well as external URLs.
If there is no appropriate destination, revise the sentence or remove the link
instead of inventing a target. An image destination can receive the same `TODO`
fix and needs the same check.

## Replace image alt text

`missing-alt-text` inserts `TODO: describe image` for an inline image with empty
or whitespace-only alt text and a nonempty source. Look at the image and its
surrounding text, then describe the information it contributes in that context.
For example:

<!-- example: image before -->
```md
![](images/revenue.png)
```

After autofix:

<!-- example: image placeholder -->
```md
![TODO: describe image](images/revenue.png)
```

After review, if the chart shows the stated trend:

<!-- example: image reviewed -->
```md
![Revenue rose from $1 million in January to $2 million in June](images/revenue.png)
```

Keep the description concise and specific to the image's purpose. For a complex
chart, include the key takeaway in the alt text and provide the detailed data in
nearby prose or a table. Verify the image source loads too; alt text cannot repair
a broken source. If an image is purely decorative, empty alt text can be
appropriate for accessibility, but this rule will flag it again. Decide how to
handle that warning in the document's accessibility workflow rather than using
misleading filler text.

## Review images with both placeholders

An image can need both a source and a description. For example, `![](?)` needs
two Fix all passes: the first inserts the alt placeholder, and the next replaces
the invalid destination. Review both parts of the resulting
`![TODO: describe image](TODO)` independently. An empty source such as `![]()`
is first flagged for its destination; after that fix, the alt rule can flag it.

For the exact rule scope, excluded Markdown regions, and examples of overlapping
fixes, see the [autofix guide](mdlint-autofix-guide.md).
