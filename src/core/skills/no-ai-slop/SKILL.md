# No AI Slop

Use this skill whenever generating, changing, or reviewing product code and terminal interfaces.

## Engineering
- Read the existing implementation and follow its real architecture before editing.
- Fix root causes; do not add duplicate layers, speculative abstractions, unused configuration, or unnecessary dependencies.
- Preserve working behavior and the project's established identity. Do not replace a real product with a generic starter template.
- Avoid placeholder implementations, fake success states, hard-coded examples presented as live data, and comments that merely narrate obvious code.
- Prefer concrete, maintainable code over excessive defensive scaffolding. Validate inputs at trust boundaries and handle failures that can cause data loss or privilege escalation.
- Do not claim an integration, feature, or test works unless it has been exercised.

## Interface quality
- Design around actual tasks, information hierarchy, and terminal or viewport constraints.
- Do not reuse a generic AI-generated layout, overuse cards, badges, borders, gradients, emojis, or decorative text.
- Keep labels concise and meaningful. Truncate long values deliberately rather than letting rows overflow or wrap unpredictably.
- Make keyboard navigation, focus, cancellation, empty states, loading states, and error states work.
- Keep related actions together and make the current selection/status obvious without duplicating the same information.

## Output quality
- Be direct. Remove repeated explanations, vague claims, inflated marketing copy, and unnecessary headings.
- Use specific names, accurate status, and evidence-based summaries.
- Verify the result with the smallest relevant automated test or reproducible check.
