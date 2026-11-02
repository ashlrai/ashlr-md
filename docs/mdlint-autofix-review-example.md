# Review an autofix for an image and a link

This example reproduces “Fix all preserves both image sources while fixing an
empty alt and a later link” in [mdlint-autofix.test.ts](../src/lib/mdlint-autofix.test.ts).
The code blocks include a final newline.

Before Fix all:

<!-- example: input -->
```md
See ![A café map](images/map.svg?view=full#north) beside ![](images/chart.png?size=2#data), then [details]().
```

Expected after Fix all:

<!-- example: output -->
```md
See ![A café map](images/map.svg?view=full#north) beside ![TODO: describe image](images/chart.png?size=2#data), then [details](TODO).
```

The `missing-alt-text` fix adds a placeholder description to the second image;
`invalid-link-target` replaces the empty link destination with `TODO`. Both
image sources and the first image's description stay unchanged. The test
checks that re-linting with the default-enabled rules finds no remaining
violations and that a second Fix all leaves the text and fix history unchanged.

Review both placeholders: replace the image description with suitable alt text
and the link destination with the intended URL or path. A clean lint result
does not mean those placeholders are finished content.
