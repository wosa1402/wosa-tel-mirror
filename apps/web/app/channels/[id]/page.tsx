import { ChannelDetails } from "@/components/channels/ChannelDetails";

export default async function ChannelDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <div className="p-8">
      <ChannelDetails channelId={id} />
    </div>
  );
}
