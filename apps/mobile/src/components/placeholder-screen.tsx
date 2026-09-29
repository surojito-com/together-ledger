import { StyleSheet, Text, View } from 'react-native';

type PlaceholderScreenProps = {
  title: string;
  description: string;
};

/**
 * A stand-in for a surface that has not been built yet. Every top-level
 * route renders one of these until its real screen lands in a later story.
 */
export function PlaceholderScreen({ title, description }: PlaceholderScreenProps) {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.description}>{description}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    padding: 24,
  },
  title: {
    fontSize: 20,
    fontWeight: '600',
  },
  description: {
    fontSize: 14,
    textAlign: 'center',
    opacity: 0.7,
  },
});
