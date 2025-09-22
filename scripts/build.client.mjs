import esbuild from 'esbuild';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

esbuild.build({
  entryPoints: [path.join(ROOT, 'client/three/app.js')],
  bundle: true,
  format: 'esm',
  splitting: false,
  sourcemap: true,
  minify: true,
  target: ['es2020'],
  outfile: path.join(ROOT, 'public/three.app.js'),
  define: {
    'process.env.NODE_ENV': '"production"'
  }
}).catch(err => {
  console.error(err);
  process.exit(1);
});
