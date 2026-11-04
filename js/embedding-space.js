export const HISTORY_VECTOR_FORMAT='history-passages-v1';
export const LORE_VECTOR_FORMAT='lore-records-v2';
function embeddingModel(row) {
  if(row.modelId)return row.modelId;
  try{const key=JSON.parse(row.modelKey ?? '');if(Array.isArray(key))return key[1] ?? '';}catch{}
  return '';
}
export function compatibleEmbedding(row,connection,format) {
  if(row.formatVersion && row.formatVersion!==format)return false;
  if(row.dimensions!=null && row.dimensions!==row.vector?.length)return false;
  const model=embeddingModel(row);
  if(model && connection.model && model!==connection.model)return false;
  if(row.modelKey===connection.key)return true;
  return !!model && model===connection.model;
}
