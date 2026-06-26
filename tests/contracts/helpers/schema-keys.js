/**
 * Extract dot-path keys from a plain JSON-schema-like object (director prompt schema).
 */
export function collectPromptSchemaPaths(value, prefix = "") {
  const paths = new Set();

  if (value == null || typeof value !== "object") {
    if (prefix) {
      paths.add(prefix);
    }
    return paths;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      if (prefix) {
        paths.add(prefix);
      }
      return paths;
    }
    for (const item of value) {
      for (const p of collectPromptSchemaPaths(item, prefix ? `${prefix}[]` : "[]")) {
        paths.add(p);
      }
    }
    return paths;
  }

  for (const [key, child] of Object.entries(value)) {
    const next = prefix ? `${prefix}.${key}` : key;
    if (Array.isArray(child)) {
      paths.add(next);
      for (const p of collectPromptSchemaPaths(child, next)) {
        paths.add(p);
      }
    } else if (child != null && typeof child === "object") {
      paths.add(next);
      for (const p of collectPromptSchemaPaths(child, next)) {
        paths.add(p);
      }
    } else {
      paths.add(next);
    }
  }

  return paths;
}

/**
 * Walk Zod object schemas and collect dot-path keys (arrays marked with []).
 */
export function collectZodSchemaPaths(schema, prefix = "") {
  const paths = new Set();
  const typeName = schema?._def?.typeName;

  if (typeName === "ZodObject") {
    const shape = schema._def.shape();
    for (const [key, child] of Object.entries(shape)) {
      const next = prefix ? `${prefix}.${key}` : key;
      for (const p of collectZodSchemaPaths(child, next)) {
        paths.add(p);
      }
    }
    return paths;
  }

  if (typeName === "ZodArray") {
    const inner = schema._def.type;
    const arrayPrefix = prefix ? `${prefix}[]` : "[]";
    if (prefix) {
      paths.add(prefix);
    }
    for (const p of collectZodSchemaPaths(inner, arrayPrefix)) {
      paths.add(p);
    }
    return paths;
  }

  if (typeName === "ZodOptional" || typeName === "ZodDefault" || typeName === "ZodNullable") {
    return collectZodSchemaPaths(schema._def.innerType, prefix);
  }

  if (typeName === "ZodEffects") {
    return collectZodSchemaPaths(schema._def.schema, prefix);
  }

  if (prefix) {
    paths.add(prefix);
  }

  return paths;
}

export function normalizePath(path) {
  return path.replace(/\[\]\[\]/g, "[]");
}

export function pathMatchesZod(promptPath, zodPaths) {
  const normalized = normalizePath(promptPath);
  if (zodPaths.has(normalized)) {
    return true;
  }
  if ([...zodPaths].some(
    (p) => p.startsWith(`${normalized}.`) || p.startsWith(`${normalized}[]`),
  )) {
    return true;
  }
  const segments = normalized.split(".");
  while (segments.length > 1) {
    segments.pop();
    const parent = segments.join(".");
    if (zodPaths.has(parent) || [...zodPaths].some((p) => p.startsWith(`${parent}.`) || p.startsWith(`${parent}[]`))) {
      return true;
    }
  }
  return false;
}

export function pathMatchesPrompt(promptPath, promptPaths) {
  const normalized = normalizePath(promptPath);
  if ([...promptPaths].some(
    (p) => p === normalized || p.startsWith(`${normalized}.`) || p.startsWith(`${normalized}[]`),
  )) {
    return true;
  }
  return false;
}
