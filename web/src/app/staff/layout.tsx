import type { Metadata } from "next";
import { StaffShell } from "@/components/StaffShell";

export const metadata: Metadata = {
  title: "いちご狩り スタッフ",
  manifest: "/staff.webmanifest",
  appleWebApp: { capable: true, title: "いちごスタッフ", statusBarStyle: "default" },
  robots: { index: false, follow: false },
};

export default function StaffLayout({ children }: LayoutProps<"/staff">) {
  return <StaffShell>{children}</StaffShell>;
}
