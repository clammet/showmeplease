import type { Metadata } from "next";
import AdminDashboard from "./AdminDashboard";

export const metadata: Metadata = {
  title: "showmeplease — admin",
  robots: { index: false },
};

export default function AdminPage() {
  return <AdminDashboard />;
}
