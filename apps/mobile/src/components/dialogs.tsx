import { useRef } from 'react';
import { AccessibilityInfo, Modal, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useShell, type DialogRequest } from '../shell/shell-provider';
import { fonts, useTheme } from '../theme';
import { StatusRegion } from './status-region';
import { Toast } from './toast';
import { Button } from './ui';

/**
 * The web's #consequence-dialog and #confirm-dialog. The confirming button names the act
 * rather than saying OK, and focus opens on the way out, so the irreversible choice is never
 * the one reached first. Android's back gesture, like Escape on the web, keeps things as they are.
 */
export function ShellDialog({ request, onClose }: { request: DialogRequest | null; onClose: (confirmed: boolean) => void }) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const keep = useRef<View>(null);
  const focusKeep = () => {
    if (keep.current) AccessibilityInfo.sendAccessibilityEvent(keep.current, 'focus');
  };
  return (
    <Modal visible={request !== null} transparent animationType="fade" statusBarTranslucent onRequestClose={() => onClose(false)} onShow={focusKeep}>
      <View style={[styles.frame, { paddingTop: insets.top + 14, paddingBottom: insets.bottom + 14, paddingLeft: insets.left + 14, paddingRight: insets.right + 14 }]}>
        {/* The web's backdrop: the text colour at 72%, so it darkens a light theme and lightens a dark one. */}
        <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[StyleSheet.absoluteFill, { backgroundColor: theme.colors.fg, opacity: 0.72 }]} />
        {request ? (
          <View accessibilityViewIsModal style={[styles.card, { backgroundColor: theme.colors.surface, borderRadius: theme.radius.xl }]}>
            <ScrollView contentContainerStyle={styles.content}>
              <StatusRegion place="dialog" />
              <Text accessibilityElementsHidden importantForAccessibility="no" style={[styles.signature, fonts.serifBold, { color: theme.colors.muted }]}>Together Ledger</Text>
              {request.kind === 'consequence' ? <Text style={[styles.eyebrow, { color: theme.colors.accent }]}>Before this happens</Text> : null}
              <Text accessibilityRole="header" style={[styles.title, fonts.serif, { color: theme.colors.fg }]}>{request.title}</Text>
              <Text style={[styles.message, { color: request.kind === 'consequence' ? theme.colors.muted : theme.colors.fg }]}>{request.message}</Text>
              <View style={styles.actions}>
                <Button ref={keep} kind="quiet" label={request.keepLabel} onPress={() => onClose(false)} />
                {/* Destructive styling only for what cannot be undone (CLAUDE.md). */}
                <Button kind={request.destructive ? 'destructive' : 'primary'} label={request.confirmLabel} onPress={() => onClose(true)} />
              </View>
            </ScrollView>
          </View>
        ) : null}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  frame: { flex: 1, justifyContent: 'center' },
  card: { maxHeight: '100%', width: '100%', maxWidth: 720, alignSelf: 'center' },
  content: { padding: 24, gap: 12 },
  signature: { fontSize: 14 },
  eyebrow: { fontSize: 12, fontWeight: '900', letterSpacing: 1.9, textTransform: 'uppercase' },
  title: { fontSize: 28, lineHeight: 34 },
  message: { fontSize: 16, lineHeight: 23 },
  actions: { gap: 10, marginTop: 13 },
});

/** The dialog and the toast, drawn once, above every screen. */
export function ShellOverlays() {
  const { dialog, answerDialog, toast } = useShell();
  return (
    <>
      <ShellDialog request={dialog} onClose={answerDialog} />
      <Toast message={toast?.message ?? null} key={toast?.id} />
    </>
  );
}
