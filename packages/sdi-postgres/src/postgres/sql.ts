/** Trusted source templates only; values are always parameters, including nested fragments. */
export class Sql {
  readonly text: string;
  readonly values: unknown[];
  constructor(text: string, values: unknown[] = []) {
    this.text = text;
    this.values = values;
  }
}
export function sql(strings: TemplateStringsArray, ...values: unknown[]): Sql {
  let text = strings[0];
  const parameters: unknown[] = [];
  values.forEach((value, index) => {
    if (value instanceof Sql) {
      const offset = parameters.length;
      text += value.text.replace(/\$(\d+)/g, (_, n) => '$' + (Number(n) + offset));
      parameters.push(...value.values);
    } else {
      parameters.push(value);
      text += '$' + parameters.length;
    }
    text += strings[index + 1];
  });
  return new Sql(text, parameters);
}
export function join(parts: Sql[], separator = ', '): Sql {
  return parts.reduce((a, b, i) => (i ? sql`${a}${new Sql(separator)}${b}` : b), new Sql(''));
}
export function identifier(name: string): Sql {
  if (!name || name.includes('\0')) throw new Error('INVALID_IDENTIFIER');
  return new Sql('"' + name.replaceAll('"', '""') + '"');
}
