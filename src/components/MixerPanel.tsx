import React from 'react';
import { ChannelLevelMetrics } from '../audio/MixerGraph';
import { ChannelLoadState, Stem, StemRole } from '../models/Stem';
import { ChannelAssignmentDiagnostic } from '../separation/SeparationTypes';
import { StemChannel } from './StemChannel';

interface MixerPanelProps {
  stems: Stem[];
  levels: Record<StemRole, ChannelLevelMetrics>;
  channelStates: Record<StemRole, ChannelLoadState>;
  channelDiagnostics: Record<StemRole, ChannelAssignmentDiagnostic>;
  isPlaying: boolean;
  onGainChange: (role: StemRole, gain: number) => void;
  onToggleMute: (role: StemRole) => void;
  onToggleSolo: (role: StemRole) => void;
  onImportFile: (role: StemRole, file: File) => void;
  onExportStemWav?: (role: StemRole, fileName?: string | null) => void;
}

export const MixerPanel: React.FC<MixerPanelProps> = ({
  stems,
  levels,
  channelStates,
  channelDiagnostics,
  isPlaying,
  onGainChange,
  onToggleMute,
  onToggleSolo,
  onImportFile,
  onExportStemWav,
}) => {
  return (
    <section aria-label="Four-Channel Stem Mixer" className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
      {stems.map((stem) => (
        <StemChannel
          key={stem.stemId}
          stem={stem}
          level={levels[stem.role]}
          loadState={channelStates[stem.role]}
          diagnostic={channelDiagnostics[stem.role]}
          isPlaying={isPlaying}
          onGainChange={onGainChange}
          onToggleMute={onToggleMute}
          onToggleSolo={onToggleSolo}
          onImportFile={onImportFile}
          onExportStemWav={onExportStemWav}
        />
      ))}
    </section>
  );
};
