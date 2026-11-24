import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';

/**
 * 10 Evaluasi Tugas Nyata Coding Agent
 */
export const EVAL_TASKS = [
  // 1. Fix Syntax Error
  {
    id: 'eval_01_fix_syntax',
    name: 'Fix JavaScript Syntax Error',
    description: 'Memperbaiki syntax error tanda kurung hilang di fungsi add',
    async setup(workspaceDir) {
      await fs.writeFile(
        path.join(workspaceDir, 'index.js'),
        'export function add(a, b {\n  return a + b;\n}\n'
      );
    },
    prompt: 'Perbaiki syntax error pada file index.js agar valid dan dapat di-check dengan node --check index.js.',
    async check(workspaceDir) {
      const filePath = path.join(workspaceDir, 'index.js');
      const content = await fs.readFile(filePath, 'utf-8');
      if (!content.includes('function add(a, b)')) return false;
      const { spawnSync } = await import('node:child_process');
      const res = spawnSync(process.execPath, ['--check', 'index.js'], { cwd: workspaceDir });
      return res.status === 0;
    }
  },

  // 2. Add Function & Export
  {
    id: 'eval_02_add_function',
    name: 'Add Multiply Function to Math Module',
    description: 'Menambahkan fungsi multiply(a, b) dan mengekspornya',
    async setup(workspaceDir) {
      await fs.writeFile(
        path.join(workspaceDir, 'math.js'),
        'export function add(a, b) { return a + b; }\nexport function subtract(a, b) { return a - b; }\n'
      );
      await fs.writeFile(
        path.join(workspaceDir, 'math.test.js'),
        'import { multiply } from "./math.js";\nif (multiply(3, 4) !== 12) process.exit(1);\nconsole.log("PASS");\n'
      );
    },
    prompt: 'Tambahkan dan ekspor fungsi multiply(a, b) yang mengembalikan hasil kali a * b ke dalam math.js.',
    async check(workspaceDir) {
      const { spawnSync } = await import('node:child_process');
      const res = spawnSync(process.execPath, ['math.test.js'], { cwd: workspaceDir });
      return res.status === 0;
    }
  },

  // 3. Refactor Variable Name
  {
    id: 'eval_03_refactor_variable',
    name: 'Refactor Variable x to count',
    description: 'Mengubah nama variabel ambigu x menjadi count dan menggunakan let/const',
    async setup(workspaceDir) {
      await fs.writeFile(
        path.join(workspaceDir, 'counter.js'),
        'var x = 0;\nexport function getCount() {\n  return x;\n}\nexport function increment() {\n  x += 1;\n  return x;\n}\n'
      );
    },
    prompt: 'Refactor counter.js: ubah nama variabel "x" menjadi "count" dan ganti "var" dengan "let".',
    async check(workspaceDir) {
      const content = await fs.readFile(path.join(workspaceDir, 'counter.js'), 'utf-8');
      return content.includes('let count = 0;') &&
        content.includes('count += 1;') &&
        !content.includes('var x');
    }
  },

  // 4. Fix Off-by-one Loop Bug
  {
    id: 'eval_04_fix_off_by_one',
    name: 'Fix Array Off-by-one Loop Bug',
    description: 'Memperbaiki loop <= arr.length menjadi < arr.length agar tidak menghasilkan NaN',
    async setup(workspaceDir) {
      await fs.writeFile(
        path.join(workspaceDir, 'sum.js'),
        'export function sumArray(arr) {\n  let total = 0;\n  for (let i = 0; i <= arr.length; i++) {\n    total += arr[i];\n  }\n  return total;\n}\n'
      );
    },
    prompt: 'Perbaiki bug di sum.js agar sumArray([1, 2, 3]) mengembalikan 6 (saat ini menghasilkan NaN karena loop melewati batas array).',
    async check(workspaceDir) {
      const fileUrl = pathToFileURL(path.join(workspaceDir, 'sum.js')).href;
      const { sumArray } = await import(fileUrl);
      return sumArray([1, 2, 3]) === 6 && sumArray([10, 20]) === 30;
    }
  },

  // 5. Create JSON Configuration
  {
    id: 'eval_05_create_json_config',
    name: 'Create Agent JSON Configuration',
    description: 'Membuat file konfigurasi JSON dengan skema yang tepat',
    async setup() {},
    prompt: 'Buat file agent.json yang berisi JSON valid dengan key "version": "1.0.0", "mode": "build", dan "enabled": true.',
    async check(workspaceDir) {
      try {
        const raw = await fs.readFile(path.join(workspaceDir, 'agent.json'), 'utf-8');
        const parsed = JSON.parse(raw);
        return parsed.version === '1.0.0' && parsed.mode === 'build' && parsed.enabled === true;
      } catch {
        return false;
      }
    }
  },

  // 6. Use Todo Tool
  {
    id: 'eval_06_todo_tool',
    name: 'Use Todo Tool for Task Planning',
    description: 'Agent mencatat rencana kerja menggunakan tool todo',
    async setup() {},
    prompt: 'Gunakan tool todo dengan action "add" untuk mencatat 2 tugas rencana: "Analyze project" dan "Write test cases".',
    async check(workspaceDir, { ctx }) {
      const todos = ctx?.todos || [];
      const hasTask1 = todos.some(t => t.task.toLowerCase().includes('analyze'));
      const hasTask2 = todos.some(t => t.task.toLowerCase().includes('test'));
      return todos.length >= 2 && hasTask1 && hasTask2;
    }
  },

  // 7. Web Fetch Content
  {
    id: 'eval_07_webfetch',
    name: 'WebFetch and Extract Text',
    description: 'Mengambil konten dari server HTTP lokal dan menyimpannya ke file teks',
    async setup(workspaceDir) {
      // Setup simple in-process HTTP mock server
      return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<html><body><h1>Nexus AI Release 2.0</h1><p>High performance coding agent</p></body></html>');
        });
        server.listen(0, '127.0.0.1', () => {
          const port = server.address().port;
          resolve({ server, port, url: `http://127.0.0.1:${port}/release` });
        });
      });
    },
    async teardown(fixtureState) {
      if (fixtureState?.server) {
        await new Promise(r => fixtureState.server.close(r));
      }
    },
    prompt: (fixtureState) => `Gunakan tool webfetch untuk mengambil konten dari ${fixtureState.url}, lalu simpan ringkasan teksnya ke file release.txt.`,
    async check(workspaceDir) {
      try {
        const content = await fs.readFile(path.join(workspaceDir, 'release.txt'), 'utf-8');
        return content.includes('Nexus AI Release 2.0') && content.includes('High performance');
      } catch {
        return false;
      }
    }
  },

  // 8. Regex Email Validator
  {
    id: 'eval_08_regex_validator',
    name: 'Implement Email Validator with Regex',
    description: 'Mengimplementasikan fungsi isValidEmail(email) menggunakan regex',
    async setup(workspaceDir) {
      await fs.writeFile(
        path.join(workspaceDir, 'validator.js'),
        'export function isValidEmail(email) {\n  // TODO: implement regex check\n  return false;\n}\n'
      );
    },
    prompt: 'Implementasikan fungsi isValidEmail(email) di validator.js menggunakan regex standar agar mengembalikan true untuk email valid dan false untuk email invalid.',
    async check(workspaceDir) {
      const fileUrl = pathToFileURL(path.join(workspaceDir, 'validator.js')).href;
      const { isValidEmail } = await import(fileUrl);
      const passValid = isValidEmail('user@nexus.ai') === true && isValidEmail('test.dev@company.co') === true;
      const passInvalid = isValidEmail('not-an-email') === false && isValidEmail('@missing.com') === false;
      return passValid && passInvalid;
    }
  },

  // 9. Handle Zero Division
  {
    id: 'eval_09_calc_zero_division',
    name: 'Handle Division by Zero Error',
    description: 'Memperbarui fungsi divide agar melempar error saat dibagi nol',
    async setup(workspaceDir) {
      await fs.writeFile(
        path.join(workspaceDir, 'calc.js'),
        'export function divide(a, b) {\n  return a / b;\n}\n'
      );
    },
    prompt: 'Ubah fungsi divide di calc.js agar melempar Error("Division by zero") ketika b === 0. Pembagian normal tetap berfungsi.',
    async check(workspaceDir) {
      const fileUrl = pathToFileURL(path.join(workspaceDir, 'calc.js')).href;
      const { divide } = await import(fileUrl);
      const normal = divide(10, 2) === 5;
      let threw = false;
      try {
        divide(10, 0);
      } catch (err) {
        threw = err.message.includes('Division by zero');
      }
      return normal && threw;
    }
  },

  // 10. Search and Replace via Grep & Edit
  {
    id: 'eval_10_search_and_replace',
    name: 'Find and Replace API Endpoint URL',
    description: 'Mencari URL lama dan menggantinya dengan endpoint baru',
    async setup(workspaceDir) {
      await fs.writeFile(
        path.join(workspaceDir, 'api.js'),
        'export const CONFIG = {\n  endpoint: "http://api.v1.local/items",\n  timeout: 5000\n};\n'
      );
    },
    prompt: 'Cari endpoint http://api.v1.local/items di file api.js dan perbarui menjadi https://api.v2.production/items.',
    async check(workspaceDir) {
      const content = await fs.readFile(path.join(workspaceDir, 'api.js'), 'utf-8');
      return content.includes('https://api.v2.production/items') && !content.includes('http://api.v1.local');
    }
  }
];
