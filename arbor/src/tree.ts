/** ONE COMPONENT OF AN ARBOR PAGE. With `arbor-client: Mobile`, every page is a tree of these:
 *  `name` is the component (`page`, `section`, `property-row`, `form-field-combobox`, …),
 *  `attributes` its settings (`label`, `value`, `url`, `targetField`, …; Arbor sends an empty
 *  list when there are none), `children` the components inside it, and `content` its text, often
 *  HTML. */
export type UiNode = {
  name: string;
  attributes: Record<string, unknown> | unknown[];
  children: UiNode[];
  content: string | null;
};

/** A node's attributes as an object: Arbor sends `[]` for none. A missing node (`findNodes(…)[0]`
 *  of nothing) has none. */
export const attributesOf = (node: UiNode | null | undefined): Record<string, unknown> =>
  node?.attributes && !Array.isArray(node.attributes) ? node.attributes : {};

/** Every node in `root` (itself included) with the component `name`, in page order. */
export function findNodes(root: UiNode, name: string): UiNode[] {
  const found: UiNode[] = [];
  const walk = (node: UiNode) => {
    if (!node || typeof node !== "object") return;
    if (node.name === name) found.push(node);
    for (const child of node.children ?? []) walk(child);
  };
  walk(root);
  return found;
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  nbsp: " ",
  pound: "£",
};

/** Arbor's HTML text (`<b>Status:</b> Paid`) as plain text: tags out, entities decoded,
 *  whitespace collapsed. */
export function textOf(html: string | null | undefined): string {
  return (html ?? "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (entity, code: string) => {
      if (code[0] === "#")
        return String.fromCodePoint(
          code[1]?.toLowerCase() === "x" ? parseInt(code.slice(2), 16) : Number(code.slice(1)),
        );
      return ENTITIES[code.toLowerCase()] ?? entity;
    })
    .replace(/\s+/g, " ")
    .trim();
}

/** One item of a data endpoint (`{ fields: { start_datetime: { value: "…" }, … } }`) as
 *  `{ start_datetime: "…", … }`. */
export function fieldValues(item: {
  fields?: Record<string, { value?: unknown } | null>;
}): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(item.fields ?? {}).map(([name, field]) => [name, field?.value ?? null]),
  );
}

/** One field of a form, as `readForm` gives it. `value` is what the app would send now: the
 *  selected option of a combobox, a hidden field's value as the page gives it. */
export type FormField = {
  /** the key in `submitForm`'s `fields` */
  field: string;
  /** the form action it belongs to */
  action: string | null;
  /** the component: `form-field-combobox`, `form-field-text`, `form-field-hidden`, … */
  type: string;
  label: string | null;
  required: boolean;
  value: unknown;
  options?: { value: string; label: string; selected: boolean }[];
};

/** An attribute as text: Arbor sends IDs and values as strings, sometimes as numbers. */
const stringOf = (value: unknown): string =>
  typeof value === "string" ? value : typeof value === "number" ? String(value) : "";

/** The forms on a page: each `form-action` (its `name` and the `url` that `submitForm` posts to)
 *  and each field, with its options and its current value. */
export function readForm(root: UiNode): {
  actions: { name: string; url: string }[];
  fields: FormField[];
} {
  const actions = findNodes(root, "form-action").map((node) => {
    const { name, url } = attributesOf(node);
    return { name: stringOf(name), url: stringOf(url) };
  });
  const fields: FormField[] = [];
  const walk = (node: UiNode) => {
    if (!node || typeof node !== "object") return;
    const attributes = attributesOf(node);
    if (node.name.startsWith("form-field-") && typeof attributes.targetField === "string") {
      // a field names its action itself, or in a form-field-action inside it
      const inner = (node.children ?? []).find((child) => child?.name === "form-field-action");
      const action = attributes.formActionName ?? (inner && attributesOf(inner).formActionName);
      const field: FormField = {
        field: attributes.targetField,
        action: typeof action === "string" ? action : null,
        type: node.name,
        label: typeof attributes.label === "string" ? attributes.label : null,
        required: attributes.required === true || attributes.required === "true",
        value: attributes.value ?? null,
      };
      const options = (node.children ?? []).filter(
        (child) => child?.name === "form-field-combobox-option",
      );
      if (options.length) {
        field.options = options.map((option) => {
          const { value, selected } = attributesOf(option);
          return {
            value: stringOf(value),
            label: textOf(option.content),
            selected: selected === "1" || selected === true,
          };
        });
        field.value = field.options.find((option) => option.selected)?.value ?? null;
      }
      fields.push(field);
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(root);
  return { actions, fields };
}
