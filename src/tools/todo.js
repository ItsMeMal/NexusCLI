/**
 * Tool todo: Agent mencatat dan mengelola rencana kerja sendiri
 */

export const todoTool = {
  name: 'todo',
  description: 'Manage a structured task and planning list. Actions: "add" (add new task), "update" (change task status: pending, in_progress, done), "list" (view all tasks), "clear" (reset todo list).',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['add', 'update', 'list', 'clear'],
        description: 'The action to perform: add, update, list, or clear'
      },
      task: {
        type: 'string',
        description: 'Description of the task to add or search'
      },
      id: {
        type: 'number',
        description: 'The 1-based ID of the task to update'
      },
      status: {
        type: 'string',
        enum: ['pending', 'in_progress', 'done'],
        description: 'The new status of the task'
      }
    },
    required: ['action']
  },

  async execute({ action, task, id, status }, ctx = {}) {
    // Todos stored on context session or in-memory fallback
    if (!ctx.todos) {
      if (ctx.session && !ctx.session.todos) {
        ctx.session.todos = [];
      }
      ctx.todos = ctx.session ? ctx.session.todos : [];
    }

    const todos = ctx.todos;

    switch (action) {
      case 'add': {
        if (!task || typeof task !== 'string' || !task.trim()) {
          return 'Error: "task" parameter is required for action "add".';
        }
        const newId = todos.length + 1;
        const item = {
          id: newId,
          task: task.trim(),
          status: status || 'pending',
          createdAt: new Date().toISOString()
        };
        todos.push(item);
        return `Added task #${newId}: "[ ] ${item.task}" (status: ${item.status})`;
      }

      case 'update': {
        if (typeof id !== 'number' || id < 1 || id > todos.length) {
          return `Error: Valid "id" (1 to ${todos.length}) is required for action "update". Current total: ${todos.length}`;
        }
        if (!status || !['pending', 'in_progress', 'done'].includes(status)) {
          return 'Error: "status" must be one of: "pending", "in_progress", "done".';
        }
        const target = todos[id - 1];
        target.status = status;
        if (task && typeof task === 'string' && task.trim()) {
          target.task = task.trim();
        }
        const icon = status === 'done' ? '[x]' : status === 'in_progress' ? '[/]' : '[ ]';
        return `Updated task #${id}: "${icon} ${target.task}" (status: ${status})`;
      }

      case 'list': {
        if (todos.length === 0) {
          return 'Todo list is currently empty. Use action "add" with "task" to create tasks.';
        }
        const lines = ['Todo list:'];
        for (const item of todos) {
          const icon = item.status === 'done' ? '[x]' : item.status === 'in_progress' ? '[/]' : '[ ]';
          lines.push(`  ${item.id}. ${icon} ${item.task} (${item.status})`);
        }
        const doneCount = todos.filter(t => t.status === 'done').length;
        lines.push(`\nProgress: ${doneCount}/${todos.length} completed`);
        return lines.join('\n');
      }

      case 'clear': {
        todos.length = 0;
        return 'Todo list cleared.';
      }

      default:
        return `Error: Unknown action "${action}". Allowed: "add", "update", "list", "clear".`;
    }
  }
};
