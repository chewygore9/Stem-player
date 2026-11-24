/**
 * Cross-platform tactile haptics utility for Ghost Stem Player.
 *
 * - On Android / Vibration API browsers: invokes `navigator.vibrate(pattern)`.
 * - On iOS 17.4+ Safari (which does not expose `navigator.vibrate`): programmatically
 *   clicks a hidden `<label>` bound to an `<input type="checkbox" switch>` inside a
 *   user gesture, triggering native iPhone Taptic Engine micro-haptics.
 */

export type HapticPattern = 'tap' | 'toggle' | 'heavy' | 'fxEngage' | 'beat' | 'success' | 'error';

const VIBRATION_PATTERNS: Record<HapticPattern, number | number[]> = {
  tap: 10,
  toggle: 16,
  heavy: 28,
  fxEngage: [12, 24, 18],
  beat: 14,
  success: [14, 30, 22],
  error: [25, 35, 25, 35, 25],
};

class HapticsController {
  private enabled = true;
  private beatHapticsEnabled = false;
  private iosLabelEl: HTMLLabelElement | null = null;
  private lastBeatPulseMs = 0;

  public isEnabled(): boolean {
    return this.enabled;
  }

  public setEnabled(val: boolean): void {
    this.enabled = val;
  }

  public isBeatHapticsEnabled(): boolean {
    return this.beatHapticsEnabled;
  }

  public setBeatHapticsEnabled(val: boolean): void {
    this.beatHapticsEnabled = val;
  }

  public supportsVibrationApi(): boolean {
    return typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
  }

  public supportsIosSwitchHaptics(): boolean {
    if (typeof navigator === 'undefined') return false;
    return /iPhone|iPad|iPod/i.test(navigator.userAgent);
  }

  private ensureIosSwitchElement(): HTMLLabelElement | null {
    if (typeof document === 'undefined') return null;
    if (this.iosLabelEl && document.body.contains(this.iosLabelEl)) {
      return this.iosLabelEl;
    }

    const wrapper = document.createElement('div');
    wrapper.setAttribute('aria-hidden', 'true');
    wrapper.style.position = 'fixed';
    wrapper.style.left = '-9999px';
    wrapper.style.top = '-9999px';
    wrapper.style.opacity = '0';
    wrapper.style.pointerEvents = 'none';

    const inputId = 'ghost-ios-taptic-switch';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.id = inputId;
    input.setAttribute('switch', '');

    const label = document.createElement('label');
    label.htmlFor = inputId;

    wrapper.appendChild(input);
    wrapper.appendChild(label);
    document.body.appendChild(wrapper);
    this.iosLabelEl = label;
    return label;
  }

  public trigger(pattern: HapticPattern = 'tap'): boolean {
    if (!this.enabled) return false;

    if (this.supportsVibrationApi()) {
      try {
        return navigator.vibrate(VIBRATION_PATTERNS[pattern]);
      } catch {
        return false;
      }
    }

    // Native iOS 17.4+ Safari Taptic switch fallback during user gestures
    if (this.supportsIosSwitchHaptics()) {
      try {
        const label = this.ensureIosSwitchElement();
        if (label) {
          label.click();
          return true;
        }
      } catch {
        return false;
      }
    }

    return false;
  }

  /**
   * Fires a rate-limited sub-bass haptic thump during playback when beat haptics are enabled.
   * Requires Vibration API support (browsers throttle background vibration automatically).
   */
  public triggerBeatPulse(subBassEnergy01: number): boolean {
    if (!this.enabled || !this.beatHapticsEnabled) return false;
    if (!this.supportsVibrationApi()) return false;

    const now = performance.now();
    // Minimum 180ms cooldown (~330 BPM ceiling) so bass hits feel punchy, never buzzy
    if (now - this.lastBeatPulseMs < 180) return false;
    if (subBassEnergy01 < 0.62) return false;

    this.lastBeatPulseMs = now;
    const durationMs = Math.round(10 + Math.min(1, subBassEnergy01) * 18);
    try {
      return navigator.vibrate(durationMs);
    } catch {
      return false;
    }
  }
}

export const haptics = new HapticsController();
