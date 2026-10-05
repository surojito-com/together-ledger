import DateTimePicker, { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import { useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { calendarDate, dayFrom } from '../journey/moment-draft';
import { useTheme } from '../theme';
import { Button, Field } from './ui';

/**
 * A day, typed as year-month-day or chosen on the phone's own calendar (#248). The calendar
 * works in UTC so the day chosen is the day stored, with no time and no time zone, as on the
 * web and the server. It needs no permission.
 */
export function DateField({ label, hint, value, onChange }: { label: string; hint?: string; value: string; onChange: (day: string) => void }) {
  const { theme } = useTheme();
  const [open, setOpen] = useState(false);

  function choose() {
    if (Platform.OS === 'android') {
      // Android's calendar is its own dialog, opened and answered in one step.
      DateTimePickerAndroid.open({ value: calendarDate(value), mode: 'date', timeZoneName: 'UTC', onValueChange: (_, date) => onChange(dayFrom(date)) });
      return;
    }
    setOpen(!open);
  }

  return (
    <View style={styles.field}>
      <Field label={label} hint={hint} value={value} onChangeText={onChange} autoCorrect={false} autoCapitalize="none" maxLength={10} />
      <Button kind="quiet" label={open ? 'Done' : 'Choose on a calendar'} onPress={choose} />
      {open && Platform.OS === 'ios' ? (
        <DateTimePicker
          value={calendarDate(value)}
          mode="date"
          display="inline"
          timeZoneName="UTC"
          accentColor={theme.colors.accent}
          themeVariant={theme.base}
          onValueChange={(_, date) => onChange(dayFrom(date))}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  field: { gap: 10 },
});
