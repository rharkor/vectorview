export const config = {
  table: process.env.PG_TABLE ?? "items",
  idColumn: process.env.PG_ID_COLUMN ?? "id",
  embeddingColumn: process.env.PG_EMBEDDING_COLUMN ?? "embedding",
  clusterColumn: process.env.PG_CLUSTER_COLUMN ?? "cluster",
  embeddingModel: process.env.EMBEDDING_MODEL ?? "openai/text-embedding-3-small",
  embeddingDim: Number(process.env.EMBEDDING_DIM ?? "1536"),
} as const;
