const fs = require('node:fs');
const path = require('node:path');
const ts = require('/compiler/node_modules/typescript');

for (const file of ['controllers/library.controller.ts', 'dtos/library.dto.ts', 'repositories/library.repository.ts', 'repositories/storage.repository.ts', 'services/library.service.ts']) {
  const filename = path.join('/upstream/server/src', file);
  const source = fs.readFileSync(filename, 'utf8').replace(/from 'src\/([^']+)'/g, (_, target) => {
    let relative = path.relative(path.dirname(filename), path.join('/upstream/server/src', target));
    if (!relative.startsWith('.')) relative = './' + relative;
    return `from '${relative}'`;
  });
  const result = ts.transpileModule(source, {
    fileName: filename,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
      experimentalDecorators: true, emitDecoratorMetadata: true,
      esModuleInterop: true, sourceMap: true, inlineSources: true,
    },
  });
  const errors = (result.diagnostics || []).filter(item => item.category === ts.DiagnosticCategory.Error);
  if (errors.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(errors, { getCanonicalFileName: f => f, getCurrentDirectory: () => '/upstream', getNewLine: () => '\n' }));
  const output = path.join('/output', file.replace(/\.ts$/, '.js'));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, result.outputText);
  fs.writeFileSync(output + '.map', result.sourceMapText);
}
