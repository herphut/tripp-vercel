// components/settings/SettingsMenu.tsx
import MemoryToggle from "./MemoryToggle";

export default function SettingsMenu() {
  return (
    <div className="space-y-6">
      <h3 className="text-lg font-semibold">Settings</h3>
      <div className="p-4 rounded-xl border">
        <div className="mb-1 font-medium">Memory</div>
        <p className="text-xs opacity-70 mb-3">
          Turn on to let Tripp remember your conversations. You can turn this off anytime.
        </p>
        <MemoryToggle />
      </div>
      {/* other settings … */}
    </div>
  );
}
