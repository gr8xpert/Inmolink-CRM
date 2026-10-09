import { describeApp } from '../app-info';

export default function HomePage() {
  return <main>{describeApp()}</main>;
}
