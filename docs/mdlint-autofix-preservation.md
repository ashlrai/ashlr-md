# What Markdown autofix preserves

These examples reproduce cases in [the autofix tests](../src/lib/mdlint-autofix.test.ts).
Linting reports a suggestion; **Fix** applies one available fix and **Fix all**
applies the available fixes together.

## Prose around a link

The `rule:invalid-link-target` test named “autofix preserves surrounding text”
checks this single fix. An invalid `#` destination becomes `TODO`; the label,
surrounding words, punctuation, and final newline remain unchanged.

Before:

<!-- example: link before -->
```md
Before [link](#) after.
```

After:

<!-- example: link after -->
```md
Before [link](TODO) after.
```

## Image sources in Fix all

The test “Fix all preserves both image sources while fixing an empty alt and a
later link” checks the combined result below. The existing image description
and both sources, including their queries and fragments, stay intact. The
empty alt text and invalid link destination receive placeholders; the prose
and final newline are preserved too. The test also checks that a second Fix
all pass leaves the result and fix history unchanged.

Before:

<!-- example: combined before -->
```md
See ![A café map](images/map.svg?view=full#north) beside ![](images/chart.png?size=2#data), then [details]().
```

After:

<!-- example: combined after -->
```md
See ![A café map](images/map.svg?view=full#north) beside ![TODO: describe image](images/chart.png?size=2#data), then [details](TODO).
```

Replace `TODO` with the intended destination and `TODO: describe image` with
appropriate alternative text. These placeholders clear the corresponding
warnings but do not supply a finished link or description. See the
[autofix guide](mdlint-autofix-guide.md) for rule scope and overlapping fixes.
