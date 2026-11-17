import { escapeHtml } from '../ui/pages.js'

/**
 * A list of the account pages, as a table. A cell is HTML that is already escaped. On a phone the columns do not
 * fit side by side, so the stylesheet stacks the cells of a row there and names each by the heading of its
 * column, which it takes from `data-label`. A column without a heading holds the button of the row.
 */
export const listTable = (headings: string[], rows: string[][]) => `<div class="scroll"><table class="list stack">
<thead><tr>${headings.map((heading) => `<th>${escapeHtml(heading)}</th>`).join('')}</tr></thead>
<tbody>
${rows.map((cells) => `<tr>${cells.map((cell, column) => `<td${headings[column] ? ` data-label="${escapeHtml(headings[column])}"` : ''}>${cell}</td>`).join('')}</tr>`).join('\n')}
</tbody></table></div>`
