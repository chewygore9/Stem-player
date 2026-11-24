import { validateLoopRegion, ValidationResult } from '../utils/validation';

export interface LoopState {
  loopEnabled: boolean;
  loopStartSeconds: number;
  loopEndSeconds: number;
}

export class LoopController {
  private state: LoopState = {
    loopEnabled: false,
    loopStartSeconds: 0,
    loopEndSeconds: 8,
  };

  public getState(): LoopState {
    return { ...this.state };
  }

  public setLoopEnabled(enabled: boolean): void {
    this.state.loopEnabled = enabled;
  }

  public setLoopBounds(
    startSeconds: number,
    endSeconds: number,
    projectDurationSeconds: number
  ): ValidationResult {
    const validation = validateLoopRegion(startSeconds, endSeconds, projectDurationSeconds);
    if (validation.valid) {
      this.state.loopStartSeconds = startSeconds;
      this.state.loopEndSeconds = endSeconds;
    }
    return validation;
  }

  public clampToDuration(projectDurationSeconds: number): void {
    if (projectDurationSeconds <= 0) return;
    if (this.state.loopEndSeconds > projectDurationSeconds) {
      this.state.loopEndSeconds = projectDurationSeconds;
    }
    if (this.state.loopStartSeconds >= this.state.loopEndSeconds) {
      this.state.loopStartSeconds = Math.max(0, this.state.loopEndSeconds - Math.min(4, projectDurationSeconds));
    }
  }
}
