import { readFileTool } from './read.js';
import { writeFileTool } from './write.js';
import { bashTool } from './bash.js';
import { grepTool } from './grep.js';
import { editFileTool } from './edit.js';
import { globTool } from './glob.js';
import { todoTool } from './todo.js';
import { webfetchTool } from './webfetch.js';
import { repoMapTool } from './repo_map.js';
import { taskTool } from './task.js';
import { ToolRegistry } from './registry.js';

export { ToolRegistry };

export function createDefaultRegistry() {
  const registry = new ToolRegistry();
  registry.register(readFileTool);
  registry.register(writeFileTool);
  registry.register(editFileTool);
  registry.register(bashTool);
  registry.register(grepTool);
  registry.register(globTool);
  registry.register(todoTool);
  registry.register(webfetchTool);
  registry.register(repoMapTool);
  registry.register(taskTool);
  return registry;
}

export const defaultRegistry = createDefaultRegistry();