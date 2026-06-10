import { pipeline, type FeatureExtractionPipeline } from "@xenova/transformers";

export class EmbeddingManager {
  private model: FeatureExtractionPipeline | null = null;
  private modelName: string;
  private dimension: number = 384;

  constructor(modelName: string = "Xenova/bge-small-en-v1.5") {
    this.modelName = modelName;
  }

  async init(): Promise<void> {
    if (this.model) return;

    // MCP stdio servers must keep stdout reserved for protocol messages.
    console.error(`Loading embedding model: ${this.modelName}...`);
    this.model = await pipeline("feature-extraction", this.modelName, {
      quantized: true // Use quantized model for faster inference
    });
    console.error("Embedding model loaded.");
  }

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

  async embedBatch(texts: string[], batchSize: number = 32): Promise<Float32Array[]> {
    if (!this.model) {
      await this.init();
    }

    const results: Float32Array[] = [];

    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);

      for (const text of batch) {
        const embedding = await this.embed(text);
        results.push(embedding);
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

  getDimension(): number {
    return this.dimension;
  }

  getModelName(): string {
    return this.modelName;
  }
}
