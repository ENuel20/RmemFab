# Glossary

| Term | Meaning |
| :--- | :--- |
| **AI workload** | A memory access pattern produced by model training or inference; in RmemFab, characterized by working set, locality, and burstiness rather than FLOPs. |
| **Backpressure** | Throttling of new transfers when a link or queue reaches its configured limit. |
| **CXL** | Compute Express Link. A cache-coherent interconnect used for memory expansion and pooling (CXL.mem) among other things. In RmemFab, modeled as a low-latency, moderate-bandwidth memory tier. |
| **CXL.mem** | The CXL protocol for host access to attached memory. |
| **Decode** | The autoregressive phase of LLM inference where one token is generated per step and the KV cache grows. |
| **Determinism** | The property that the same version, scenario, seed, and trace produce the same result. |
| **Discrete-event simulation (DES)** | A simulation that advances a virtual clock from event to event instead of in fixed time steps. |
| **DRAM** | Dynamic random-access memory. In RmemFab, the local memory tier of a compute node. |
| **Eviction** | Removing a page from a tier to free capacity. May require write-back if dirty. |
| **Fabric** | The interconnect between compute nodes and remote memory, for example CXL or RDMA. |
| **Fault injection** | Deliberately introducing failures (node loss, link degradation, packet loss) to study resilience. |
| **GQA / MQA** | Grouped-query attention / multi-query attention. Attention variants that share key/value heads across query heads, reducing KV cache size. |
| **Hit ratio** | Fraction of accesses served by a given tier without fetching from a slower tier. |
| **Hot/cold migration** | Moving frequently accessed pages closer and infrequently accessed pages farther away. |
| **In-flight limit** | Maximum bytes a link may have outstanding at once. |
| **JSONL** | Newline-delimited JSON; one record per line. Used for event logs and traces. |
| **KV cache** | Key/value tensors cached during LLM inference so previous tokens do not need recomputation. Its size grows with context length and batch size. |
| **Latency** | One-way delay for an access or transfer, in nanoseconds. |
| **Locality** | The tendency of a workload to reuse recently accessed or nearby pages (temporal and spatial locality). |
| **LRU** | Least recently used. A baseline replacement policy. |
| **LRU-K** | A replacement policy that considers the K-th most recent access to estimate reuse probability. |
| **Migration** | Moving a page from one tier to another. |
| **MoE** | Mixture of Experts. A model architecture where only a subset of experts is activated per token, creating a large, sparsely used parameter set. |
| **NUMA** | Non-uniform memory access. Local memory latency/bandwidth depends on the accessing socket. |
| **Page** | The unit of placement and accounting in the simulator, configurable in size. |
| **p50 / p95 / p99** | Percentiles of a latency distribution. Tails matter for interactive serving. |
| **Prefetch** | Fetching a page before it is requested, based on predicted future access. |
| **Prefill** | The prompt-processing phase of LLM inference, typically large and sequential. |
| **Pressure** | The ratio of tier occupancy to capacity. Policies act at configured watermarks. |
| **RDMA** | Remote Direct Memory Access. Low-latency network memory access, for example over RoCEv2 or InfiniBand. In RmemFab, modeled as a microsecond-latency tier. |
| **Remote memory** | Memory attached to another node or pool and accessed over a fabric. |
| **Replay** | Running a captured trace through the simulator. |
| **Seed** | Integer input that initializes random streams. Same seed plus same inputs yields the same run. |
| **Sparse attention** | Attention that touches only a subset of the KV cache, producing irregular access patterns. |
| **Stall time** | Time a request spends waiting on memory beyond the local-hit baseline. |
| **Swap** | Treating a slower tier as a backing store for pages evicted from a faster tier. |
| **Telemetry** | Structured events and metrics emitted by the simulator. |
| **Throughput** | Work completed per unit of virtual time, such as requests or tokens per second. |
| **Trace** | A recorded sequence of memory operations with timestamps. |
| **Utilization** | Offered load divided by link or tier capacity; 100% means saturated. |
| **Working set** | The set of pages actively needed over a time window. |
