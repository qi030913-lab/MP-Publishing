import { createDocumentSummary, exampleDocument } from "@mp-publishing/content-model";
import { adapterRegistry } from "@mp-publishing/adapter-core";

async function bootstrap() {
  const summary = createDocumentSummary(exampleDocument);
  const adapters = adapterRegistry.listCapabilities().map((item) => item.platform);

  console.log("worker bootstrap");
  console.log(summary);
  console.log(`registered adapters: ${adapters.join(", ")}`);
}

void bootstrap();
