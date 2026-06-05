import { beforeEach, describe, expect, it } from "vitest";
import { memoryBlock, useMemoryStore } from "./memoryStore";

beforeEach(() => useMemoryStore.setState({ items: [] }));

describe("memoryStore", () => {
  it("adds a trimmed item", () => {
    useMemoryStore.getState().add("  I like concise answers  ");
    const items = useMemoryStore.getState().items;
    expect(items).toHaveLength(1);
    expect(items[0].text).toBe("I like concise answers");
    expect(items[0].source).toBe("user");
  });

  it("ignores empty/whitespace text", () => {
    useMemoryStore.getState().add("   ");
    expect(useMemoryStore.getState().items).toHaveLength(0);
  });

  it("dedups identical facts", () => {
    const { add } = useMemoryStore.getState();
    add("TypeScript only");
    add("TypeScript only");
    expect(useMemoryStore.getState().items).toHaveLength(1);
  });

  it("removes by id and clears", () => {
    const { add } = useMemoryStore.getState();
    add("a");
    add("b");
    const id = useMemoryStore.getState().items[0].id;
    useMemoryStore.getState().remove(id);
    expect(useMemoryStore.getState().items).toHaveLength(1);
    useMemoryStore.getState().clear();
    expect(useMemoryStore.getState().items).toHaveLength(0);
  });

  it("memoryBlock is empty when no items, formatted otherwise", () => {
    expect(memoryBlock()).toBe("");
    useMemoryStore.getState().add("Project: Ashlr MD");
    const block = memoryBlock();
    expect(block).toContain("- Project: Ashlr MD");
    expect(block.toLowerCase()).toContain("about this user");
  });
});
