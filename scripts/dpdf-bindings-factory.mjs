import { readFileSync } from 'node:fs';

const EXPORTED_CLASS = 'export class Dpdf ';
const EXPORT_LIST = 'export { initSync, __wbg_init as default };';

// wasm-bindgen glue keeps its instance in module-level variables and initSync returns the first one
// forever. Wrapping the glue in a function gives every call its own instance, so the read-ahead worker
// can start over after a wasm trap. A glue of a different shape fails the build instead of shipping.
export function toBindingsFactory(source) {
  if (!source.includes(EXPORTED_CLASS) || !source.includes(EXPORT_LIST)) {
    throw new Error('the wasm-bindgen glue changed shape, so update toBindingsFactory');
  }
  const body = source.replace(EXPORTED_CLASS, 'class Dpdf ').replace(EXPORT_LIST, '');
  if (/^\s*(import|export)\b/m.test(body)) throw new Error('the wasm-bindgen glue has an import or export left');
  return `export default function createDpdfBindings() {\n${body}\nreturn { Dpdf, initSync };\n}\n`;
}

export function dpdfBindingsPlugin(gluePath) {
  return {
    name: 'dpdf-bindings',
    setup(build) {
      build.onResolve({ filter: /^dpdf-bindings$/ }, () => ({ path: gluePath, namespace: 'dpdf-bindings' }));
      build.onLoad({ filter: /.*/, namespace: 'dpdf-bindings' }, ({ path }) => ({
        contents: toBindingsFactory(readFileSync(path, 'utf8')),
        loader: 'js',
      }));
    },
  };
}
