const { readConfig } = require('../services/config');

async function handleDeployConfig(subcommand) {
  if (subcommand !== 'list') {
    return { text: 'Usage: `/deploy-config list`' };
  }

  const config = await readConfig();

  const lines = ['*Groups:*'];
  for (const [groupName, steps] of Object.entries(config.groups || {})) {
    lines.push(`\n*\`${groupName}\`*`);
    for (const { step, projects } of steps) {
      const names = projects.map((p) => `${p.name} (${p.repo})`).join(', ');
      lines.push(`  Step ${step}: ${names}`);
    }
  }

  lines.push('\n*Projects:*');
  for (const [name, project] of Object.entries(config.projects || {})) {
    const detail = project.mergeOnly ? 'merge-only' : `workflows: ${(project.workflows ?? []).join(', ') || '(none)'}`;
    lines.push(`• \`${name}\`  ${project.repo}  ${detail}`);
  }

  return { text: lines.join('\n') };
}

module.exports = { handleDeployConfig };
