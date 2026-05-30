import { Injectable } from "@nestjs/common";
import { getRuntimeStats } from "@mp-publishing/task-runtime";

@Injectable()
export class RuntimeService {
  async getStatus() {
    return getRuntimeStats();
  }
}
