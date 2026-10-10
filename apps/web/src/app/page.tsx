import { describeApp } from '../app-info';

export default function HomePage() {
  return <main className="p-6 text-sm text-muted-foreground">{describeApp()}</main>;
}
