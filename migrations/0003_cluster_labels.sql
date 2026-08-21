ALTER TABLE dataset_meta ADD COLUMN IF NOT EXISTS cluster_labels jsonb;
ALTER TABLE dataset_meta ADD COLUMN IF NOT EXISTS cluster_column text;
