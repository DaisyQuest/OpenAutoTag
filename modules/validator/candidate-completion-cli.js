import { readFile } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import schema from '../../contracts/candidate-completion.schema.json' with { type: 'json' };
import { evaluateCandidateCompletion } from './candidate-completion.js';
try {
  if (process.argv.length !== 3) throw new Error('Usage: candidate-completion-cli.js <input.json>');
  const report = evaluateCandidateCompletion(JSON.parse(await readFile(process.argv[2], 'utf8')));
  const validate = new Ajv2020().compile(schema);
  if (!validate(report)) throw new Error(`Invalid completion report: ${JSON.stringify(validate.errors)}`);
  process.stdout.write(JSON.stringify(report) + '\n');
} catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
