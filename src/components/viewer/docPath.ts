/**
 * docPath.ts — the document a rendered Markdown tree belongs to.
 *
 * Relative links, images and wikilinks resolve from the document that holds
 * them. The read view renders the open document, but an embed
 * (`![[other]]`) renders another file through the same Renderer, and its
 * links used to resolve from the open document (the store's `path`), so a
 * `![](img.png)` next to the embedded note was looked for next to the host.
 * An embed provides its own file's path here; outside one, the open
 * document's path is used.
 */

import { createContext, useContext } from "react";
import { useDocumentStore } from "../../store/documentStore";

/** The path of the embedded file being rendered; `undefined` outside an embed. */
export const DocPathContext = createContext<string | null | undefined>(undefined);

/** The path relative links in this part of the tree resolve from. */
export function useDocPath(): string | null {
  const embedded = useContext(DocPathContext);
  const open = useDocumentStore((s) => s.path);
  return embedded === undefined ? open : embedded;
}
