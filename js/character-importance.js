// User-owned importance metadata. Retrieval uses it; model prompts do not expose it.
export const CHARACTER_IMPORTANCE = [
  {value:1,label:'Core',description:'Major influence, relationships, and long-term development.'},
  {value:2,label:'Major',description:'Meaningful goals and decisions; involved in significant plots.'},
  {value:3,label:'Minor',description:'Named character with limited involvement, occasional appearances, or a specific role.'},
  {value:4,label:'Background',description:'Populates the world with minimal development or plot significance.'}
];
export function characterImportance(entry) {
  return CHARACTER_IMPORTANCE.some(option=>option.value===entry.importance) ? entry.importance : 3;
}
export function validateImportance(entry) {
  if(entry.book==='characters' && entry.importance!==undefined && !CHARACTER_IMPORTANCE.some(option=>option.value===entry.importance))throw new Error('Character importance must be an integer from 1 to 4.');
}
