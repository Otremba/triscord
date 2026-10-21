import type { IconName } from '../../icons.generated';
import { Icon } from '../Icon';

export interface DeviceOption { id: string; name: string; isDefault?: boolean }

export function deviceChoices(value: string, options: DeviceOption[]) {
  const fallback = options.find(option => option.isDefault)?.name;
  const seen = new Set(['']);
  const choices = [{ id: '', name: `Padrão do Windows${fallback ? ` (${fallback})` : ''}`, unavailable: false }];
  for (const option of options) {
    if (seen.has(option.id)) continue;
    seen.add(option.id);
    choices.push({ id: option.id, name: option.name, unavailable: false });
  }
  // A removed device stays visible until the user deliberately selects its replacement.
  if (value && !seen.has(value)) choices.push({ id: value, name: 'Dispositivo indisponível — escolha outro', unavailable: true });
  return choices;
}

export function DeviceSelect({ value, options, icon, label, onChange }: {
  value: string; options: DeviceOption[]; icon?: IconName; label: string; onChange: (id: string) => void;
}) {
  return <div class="tri-device-select">
    {icon && <Icon name={icon} size={20} className="tri-device-select__icon" />}
    <select value={value} aria-label={label} onChange={event => {
      const next = event.currentTarget.value;
      if (next !== value) onChange(next);
    }}>
      {deviceChoices(value, options).map(option => <option key={option.id} value={option.id} disabled={option.unavailable}>{option.name}</option>)}
    </select>
  </div>;
}
