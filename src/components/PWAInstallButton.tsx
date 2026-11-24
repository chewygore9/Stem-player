import React, { useState } from 'react';
import { Download, Smartphone } from 'lucide-react';
import { usePWAInstall } from '../hooks/usePWAInstall';

export const PWAInstallButton: React.FC = () => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showModal, setShowModal] = useState(false);

  if (isInstalled) {
    return null;
  }

  if (isInstallable) {
    return (
      <button
        type="button"
        onClick={install}
        className="min-h-[40px] px-3.5 py-2 rounded-xl bg-purple-600 hover:bg-purple-500 text-xs font-semibold text-white flex items-center gap-1.5 transition whitespace-nowrap shrink-0"
      >
        <Download className="w-3.5 h-3.5" />
        <span>Install App</span>
      </button>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setShowModal(true)}
        className="min-h-[40px] px-3.5 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-xs font-medium text-zinc-200 flex items-center gap-1.5 transition whitespace-nowrap shrink-0"
      >
        <Smartphone className="w-3.5 h-3.5 text-purple-400" />
        <span>{isIOS ? 'Install on iPhone' : 'PWA Setup'}</span>
      </button>

      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
          <div className="w-full max-w-sm rounded-2xl bg-zinc-900 border border-zinc-800 p-5 shadow-2xl">
            <h3 className="font-display text-base font-bold text-zinc-100">
              Install Ghost Stem Player on iPhone
            </h3>
            <p className="mt-2 text-xs text-zinc-300 leading-relaxed">
              Ghost Stem Player is configured as a standalone portrait Progressive Web Application:
            </p>
            <ol className="mt-3 space-y-2 text-xs text-zinc-300 list-decimal list-inside">
              <li>
                Open this URL in <strong>Safari</strong> on your iPhone.
              </li>
              <li>
                Tap the <strong>Share</strong> button in the bottom Safari bar.
              </li>
              <li>
                Select <strong>Add to Home Screen</strong> to launch in full-screen standalone mode.
              </li>
            </ol>
            <button
              type="button"
              onClick={() => setShowModal(false)}
              className="mt-5 w-full min-h-[44px] rounded-xl bg-purple-600 hover:bg-purple-500 text-xs font-semibold text-white transition"
            >
              Got It
            </button>
          </div>
        </div>
      )}
    </>
  );
};
