export function validateJsonSchema(schema, value, rootSchema = schema, instancePath = "$") {
  const errors = [];
  validateNode(schema, value, rootSchema, instancePath, errors);
  return {valid: errors.length === 0, errors};
}

function validateNode(schema, value, rootSchema, instancePath, errors) {
  if (schema.$ref) {
    const target = resolveLocalRef(rootSchema, schema.$ref);
    validateNode(target, value, rootSchema, instancePath, errors);
    return;
  }
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((candidate) => validateJsonSchema(candidate, value, rootSchema, instancePath).valid);
    if (matches.length !== 1) errors.push(`${instancePath}: expected exactly one schema match`);
    return;
  }
  if (schema.anyOf) {
    if (!schema.anyOf.some((candidate) => validateJsonSchema(candidate, value, rootSchema, instancePath).valid)) {
      errors.push(`${instancePath}: expected at least one schema match`);
    }
    return;
  }
  if (Object.hasOwn(schema, "const") && value !== schema.const) {
    errors.push(`${instancePath}: expected constant ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${instancePath}: value is not in enum`);
  }
  if (schema.type && !matchesType(schema.type, value)) {
    errors.push(`${instancePath}: expected ${schema.type}`);
    return;
  }
  if (typeof value === "string" && schema.minLength !== undefined && value.length < schema.minLength) {
    errors.push(`${instancePath}: string shorter than ${schema.minLength}`);
  }
  if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum) {
    errors.push(`${instancePath}: number below ${schema.minimum}`);
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, index) => validateNode(schema.items, item, rootSchema, `${instancePath}[${index}]`, errors));
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) errors.push(`${instancePath}: missing required property ${key}`);
    }
    for (const [key, child] of Object.entries(value)) {
      if (schema.properties?.[key]) {
        validateNode(schema.properties[key], child, rootSchema, `${instancePath}.${key}`, errors);
      } else if (schema.additionalProperties === false) {
        errors.push(`${instancePath}: unexpected property ${key}`);
      } else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        validateNode(schema.additionalProperties, child, rootSchema, `${instancePath}.${key}`, errors);
      }
    }
  }
}

function matchesType(type, value) {
  if (Array.isArray(type)) return type.some((candidate) => matchesType(candidate, value));
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "integer") return Number.isInteger(value);
  return typeof value === type;
}

function resolveLocalRef(rootSchema, reference) {
  if (!reference.startsWith("#/")) throw new Error(`Only local JSON Schema refs are supported: ${reference}`);
  return reference.slice(2).split("/").reduce((node, segment) => node[segment.replace(/~1/g, "/").replace(/~0/g, "~")], rootSchema);
}
