import { pipeline, type FeatureExtractionPipeline } from "@xenova/transformers";

/**
 * Query-side instruction prefixes, per model.
 *
 * Several retrieval models are trained asymmetrically: documents are embedded
 * bare, but queries are expected to carry an instruction prefix. Omitting it
 * costs recall silently — the vectors still look fine, they are just in a
 * slightly different place than the model was trained to put them.
 *
 * Documents never get a prefix. Only `embedQuery` applies these.
 */
const MODEL_QUERY_PREFIX: Record<string, string> = {
  // BGE v1.5 family — prefix documented by BAAI for retrieval.
  "Xenova/bge-small-en-v1.5": "Represent this sentence for searching relevant passages: ",
  "Xenova/bge-base-en-v1.5": "Represent this sentence for searching relevant passages: ",
  "Xenova/bge-large-en-v1.5": "Represent this sentence for searching relevant passages: ",
  // Snowflake arctic-embed v1 family uses the same instruction.
  "Snowflake/snowflake-arctic-embed-xs": "Represent this sentence for searching relevant passages: ",
  "Snowflake/snowflake-arctic-embed-s": "Represent this sentence for searching relevant passages: ",
  "Snowflake/snowflake-arctic-embed-m": "Represent this sentence for searching relevant passages: ",
  // Jina v2 models are symmetric — a prefix would only add noise.
  "jinaai/jina-embeddings-v2-base-code": "",
  "jinaai/jina-embeddings-v2-base-en": "",
  "jinaai/jina-embeddings-v2-small-en": ""
};

/**
 * Resolve the query prefix for a model.
 *
 * `CODERECALL_QUERY_PREFIX` overrides the registry (set it to an empty string
 * to disable prefixing entirely). Unknown models default to no prefix, since a
 * wrong prefix is worse than none.
 */
export function queryPrefixFor(modelName: string): string {
  const override = process.env.CODERECALL_QUERY_PREFIX;
  if (override !== undefined) return override;
  return MODEL_QUERY_PREFIX[modelName] ?? "";
}

export class EmbeddingManager {
  private model: FeatureExtractionPipeline | null = null;
  private modelName: string;
  /** Learned from the model's own output rather than assumed. Null until init(). */
  private dimension: number | null = null;
  private queryPrefix: string;

  constructor(modelName: string = "Xenova/bge-small-en-v1.5") {
    this.modelName = modelName;
    this.queryPrefix = queryPrefixFor(modelName);
  }

  async init(): Promise<void> {
    if (this.model) return;

    // MCP stdio servers must keep stdout reserved for protocol messages.
    console.error(`Loading embedding model: ${this.modelName}...`);
    this.model = await pipeline("feature-extraction", this.modelName, {
      quantized: true // Use quantized model for faster inference
    });

    // Probe the real output width instead of hardcoding it: swapping to a
    // different-width model must not silently produce vectors that cannot be
    // compared against what is already stored.
    const probe = await this.model("dimension probe", { pooling: "mean", normalize: true });
    this.dimension = Number((probe.dims as number[])[probe.dims.length - 1]);

    console.error(
      `Embedding model loaded (${this.dimension}-D` + `${this.queryPrefix ? ", query prefix enabled" : ""}).`
    );
  }

  /**
   * Embed a document/chunk. No instruction prefix — the stored side is bare.
   */
  async embed(text: string): Promise<Float32Array> {
    if (!this.model) {
      await this.init();
    }

    const output = await this.model!(text, {
      pooling: "mean",
      normalize: true
    });

    // Convert to Float32Array (xenova returns a typed array but TS sees DataArray union)
    return new Float32Array(output.data as unknown as ArrayLike<number>);
  }

  /**
   * Embed a search query, applying the model's query-side instruction prefix.
   * Use this for anything compared *against* the index, never for what goes in.
   */
  async embedQuery(text: string): Promise<Float32Array> {
    return this.embed(this.queryPrefix + text);
  }

  async embedBatch(texts: string[], batchSize: number = 8): Promise<Float32Array[]> {
    if (!this.model) {
      await this.init();
    }

    if (texts.length === 0) return [];

    const results: Float32Array[] = [];

    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);

      const output = await this.model!(batch, {
        pooling: "mean",
        normalize: true
      });

      // Batched output shape is [batch, dim]; output.data is a flat Float32Array
      // of length batch * dim. Slice into per-row Float32Arrays.
      const flat = output.data as unknown as Float32Array;
      const dim =
        Array.isArray(output.dims) && output.dims.length >= 2
          ? (output.dims[output.dims.length - 1] as number)
          : flat.length / batch.length;

      for (let j = 0; j < batch.length; j++) {
        results.push(new Float32Array(flat.slice(j * dim, (j + 1) * dim)));
      }
    }

    return results;
  }

  // Cosine similarity between two vectors
  static cosineSimilarity(a: Float32Array, b: Float32Array): number {
    if (a.length !== b.length) {
      throw new Error("Vectors must have the same length");
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      const aVal = a[i]!;
      const bVal = b[i]!;
      dotProduct += aVal * bVal;
      normA += aVal * aVal;
      normB += bVal * bVal;
    }

    const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
    if (magnitude === 0) return 0;

    return dotProduct / magnitude;
  }

  // Find top-k similar vectors
  static findSimilar(
    queryVector: Float32Array,
    candidates: Array<{ id: string; vector: Float32Array }>,
    topK: number = 10,
    minSimilarity: number = 0.0
  ): Array<{ id: string; similarity: number }> {
    const scored = candidates.map((candidate) => ({
      id: candidate.id,
      similarity: EmbeddingManager.cosineSimilarity(queryVector, candidate.vector)
    }));

    return scored
      .filter((item) => item.similarity >= minSimilarity)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, topK);
  }

  /** Output width of the loaded model. Throws if called before init(). */
  getDimension(): number {
    if (this.dimension === null) {
      throw new Error("Embedding dimension unknown — call init() first.");
    }
    return this.dimension;
  }

  getModelName(): string {
    return this.modelName;
  }

  getQueryPrefix(): string {
    return this.queryPrefix;
  }
}
