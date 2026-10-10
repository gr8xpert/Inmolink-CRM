import { setRequestLocale } from 'next-intl/server';
import { describeApp } from '../../app-info';

export default async function HomePage({ params }: { params: Promise<{ locale: string }> }) {
  setRequestLocale((await params).locale);
  return <main className="p-6 text-sm text-muted-foreground">{describeApp()}</main>;
}
