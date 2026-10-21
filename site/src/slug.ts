/** The id GitHub gives a heading, so that anchors in the documents work on GitHub and on the site alike. */
export const slugify = (text: string) =>
  text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-')

/** Makes the ids of one page unique the way GitHub does: the second "Notes" is "notes-1". */
export const createSlugger = () => {
  const used = new Map<string, number>()
  return (text: string) => {
    const base = slugify(text)
    const count = used.get(base) ?? 0
    used.set(base, count + 1)
    return count === 0 ? base : `${base}-${count}`
  }
}
